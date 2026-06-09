// Translate the raw error strings the brain forwards in `errorMessage` into
// something a user can act on. pi-ai's providers fall back to
// `JSON.stringify(error)` when the upstream throws a non-Error (which is what
// the Anthropic SDK does for HTTP errors), so we end up showing the wire
// payload verbatim in chat unless we unwrap it here.

export interface HumanizedError {
  text: string;
  retriable: boolean;
}

interface AnthropicLikeError {
  type?: string;
  error?: { type?: string; message?: string };
  message?: string;
}

const RETRIABLE_TYPES = new Set(["overloaded_error", "rate_limit_error", "api_error"]);

// Context-overflow errors arrive in many provider-specific phrasings, and for
// OpenAI-compatible endpoints they're a plain (non-JSON) string the humanizer
// would otherwise echo verbatim -- e.g. deepseek's "400 This model's maximum
// context length is N tokens. However, you requested M tokens..." (issue #209).
// Dumping that raw is alarming and unactionable, so we detect the signature and
// point the user at the real lever (/compact). Patterns mirror pi-ai's
// isContextOverflow() but stay self-contained so the renderer doesn't pull in
// the brain's provider layer. request_too_large keeps its own case below.
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic token overflow
  /exceeds the context window/i, // OpenAI
  /maximum context length/i, // OpenAI / OpenRouter / LiteLLM proxies
  /reduce the length of the messages/i, // Groq / deepseek tail
  /maximum prompt length is \d+/i, // xAI (Grok)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /too large for model with \d+ maximum context length/i, // Mistral
  /is longer than the model'?s context length/i, // Together AI
  /context[_ ]length[_ ]exceeded/i, // OpenAI error code / generic
];

// Rate-limit / throttling errors sometimes mention "tokens"; resending after a
// pause is the right move for those, not /compact -- so never treat them as
// overflow even when an overflow phrase coincidentally matches.
const NOT_OVERFLOW_PATTERNS = [/rate limit/i, /too many requests/i, /throttl/i];

function isContextOverflowError(text: string): boolean {
  if (NOT_OVERFLOW_PATTERNS.some((p) => p.test(text))) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(text));
}

export function humanizeAgentError(raw: string | undefined | null): HumanizedError {
  if (!raw) return { text: "Unknown error", retriable: false };
  const trimmed = raw.trim();

  // Check overflow first, against the whole string: the signature can be a bare
  // string (OpenAI-compatible) or buried in a JSON error body, and either way
  // /compact is the actionable answer.
  if (isContextOverflowError(trimmed)) {
    return {
      text:
        "This conversation is too long for the model's context window. " +
        "Run /compact to compact it (or start a new session), then resend.",
      retriable: false,
    };
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { text: raw, retriable: false };
  }

  let parsed: AnthropicLikeError;
  try {
    parsed = JSON.parse(trimmed) as AnthropicLikeError;
  } catch {
    return { text: raw, retriable: false };
  }

  const inner = parsed.error;
  const errType = inner?.type;
  const errMsg = inner?.message ?? parsed.message ?? "";

  // Google's consumer Generative Language API geo-blocks unsupported regions
  // with a 400 FAILED_PRECONDITION. It keys the error on `status`/`code`, not
  // the Anthropic-style `type`, so it slips past the switch below -- match its
  // stable message and explain it instead of echoing the raw payload.
  if (/user location is not supported/i.test(errMsg)) {
    return {
      text: "Gemini isn't available in your region -- Google blocked the request. Switch to a non-Google provider (e.g. Anthropic, OpenAI, or DeepSeek) in Preferences.",
      retriable: false,
    };
  }

  switch (errType) {
    case "overloaded_error":
      return {
        text: "Anthropic is overloaded right now -- give it a moment and resend.",
        retriable: true,
      };
    case "rate_limit_error":
      return {
        text: errMsg
          ? `Rate limited by the API: ${errMsg}. Try again shortly.`
          : "Rate limited by the API. Try again shortly.",
        retriable: true,
      };
    case "api_error":
      return {
        text: errMsg
          ? `Upstream API error: ${errMsg}. Try again.`
          : "Upstream API error. Try again.",
        retriable: true,
      };
    case "authentication_error":
      return {
        text: "Authentication failed -- check your API key in Preferences.",
        retriable: false,
      };
    case "permission_error":
      return {
        text: errMsg ? `Permission denied: ${errMsg}` : "Permission denied.",
        retriable: false,
      };
    case "not_found_error":
      return {
        text: errMsg ? `Model or resource not found: ${errMsg}` : "Model or resource not found.",
        retriable: false,
      };
    case "request_too_large":
      return {
        text: "Request is too large for the model. Shorten the prompt or start a fresh session.",
        retriable: false,
      };
    case "invalid_request_error":
      return {
        text: errMsg ? `Invalid request: ${errMsg}` : "Invalid request.",
        retriable: false,
      };
  }

  if (errMsg) {
    return {
      text: errType ? `${errType}: ${errMsg}` : errMsg,
      retriable: errType ? RETRIABLE_TYPES.has(errType) : false,
    };
  }
  return { text: raw, retriable: false };
}
