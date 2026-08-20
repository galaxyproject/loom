import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { shell } from "electron";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

/**
 * pi hides its OAuth flow modules from bundlers on purpose: `auth/oauth/load.ts`
 * imports them through a variable specifier so Rollup cannot follow the import
 * into Node-only flow code. Vite therefore leaves `./openai-codex.js` in the
 * main bundle verbatim, and at runtime that resolves against `.vite/build/`
 * rather than pi's dist -- sign-in dies with "Cannot find module".
 *
 * pi's escape hatch for bundled hosts is registerBundledOAuthFlowLoaders, which
 * ships prewired as registerBunOAuthFlows. The "Bun" in the name is about the
 * standalone binary it was written for, not a Bun runtime requirement: its
 * imports are static, so Vite bundles the flows and the variable-specifier path
 * is never taken. Register at module load, before any flow can be reached.
 */
registerBunOAuthFlows();

/**
 * OAuth provider integration for the brain's auth.json. The brain (pi-coding-agent)
 * reads `~/.pi/agent/auth.json` directly when spawned with `--provider <oauth-provider>`,
 * so all Orbit needs to do is run the OAuth flow and persist the resulting credentials
 * to that file. The brain handles refresh on its own via AuthStorage's locking.
 */

/**
 * How long sign-in may sit waiting on the browser redirect before Orbit gives up.
 * Generous enough for a real login (fresh account, 2FA, password manager), short
 * enough that a dead flow doesn't hold the callback port for the life of the app.
 */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Which providers authenticate by sign-in is pi's business, not ours: since pi
 * 0.81 each provider carries its own `auth.oauth`, so we read the list off the
 * registry instead of hardcoding it and going stale the next time pi adds one.
 *
 * What we must NOT read off it is "therefore this provider has no API key".
 * pi models the two independently: `openai-codex` carries `auth.oauth` alone,
 * while anthropic, xai, openrouter, kimi-coding, github-copilot and radius
 * carry `auth.apiKey` AND `auth.oauth`. Collapsing sign-in-capable into
 * OAuth-only is what broke #429 -- Orbit stopped showing, storing, reporting
 * and injecting the Anthropic API key the moment pi taught Anthropic to
 * sign in, and the brain then judged the provider unusable.
 *
 * That read is async and several callers are sync, so prime the cache once at
 * startup (primeOAuthProviders) and let the sync accessors serve from it. The
 * seed keeps pre-prime calls honest for the provider we know ships enabled;
 * every other provider reads as "takes an API key" until the registry lands,
 * which is the safe default -- it offers a key field rather than hiding one.
 */
export interface ProviderAuthCaps {
  /** Sign-in button label, e.g. "OpenAI (ChatGPT Plus/Pro)". "" when pi gives none. */
  signInLabel: string;
  /** pi defines an API-key auth path for this provider (dual-auth when it also signs in). */
  acceptsApiKey: boolean;
}

/**
 * Classify one provider's auth surface. Returns null when the provider offers
 * no sign-in at all. Pure and exported so the OAuth-only predicate -- the thing
 * #429 got wrong -- is testable without an Electron or pi runtime.
 */
export function classifyProviderAuth(provider: {
  id: string;
  auth?: {
    apiKey?: unknown;
    oauth?: { login?: unknown; name?: string; loginLabel?: string };
  };
}): ProviderAuthCaps | null {
  const oauth = provider.auth?.oauth;
  if (!oauth?.login) return null;
  return {
    signInLabel: oauth.loginLabel || oauth.name || "",
    acceptsApiKey: Boolean(provider.auth?.apiKey),
  };
}

const SEED_OAUTH_PROVIDERS: Array<[string, ProviderAuthCaps]> = [
  ["openai-codex", { signInLabel: "", acceptsApiKey: false }],
];
let oauthProviders: Map<string, ProviderAuthCaps> = new Map(SEED_OAUTH_PROVIDERS);
let priming: Promise<ReadonlyMap<string, ProviderAuthCaps>> | null = null;

/** Read the sign-in-capable providers off pi's registry. Call once at startup. */
export async function primeOAuthProviders(): Promise<ReadonlyMap<string, ProviderAuthCaps>> {
  priming ??= (async () => {
    try {
      const runtime = await ModelRuntime.create({ authPath: getAuthPath() });
      const found = new Map<string, ProviderAuthCaps>();
      for (const provider of await runtime.getProviders()) {
        const caps = classifyProviderAuth(provider);
        if (caps) found.set(provider.id, caps);
      }
      // Never shrink below the seed -- an empty read means something is wrong with
      // the registry, not that sign-in stopped existing.
      if (found.size > 0) oauthProviders = found;
    } catch (err) {
      console.error("[oauth] could not read providers from the registry:", err);
    }
    return oauthProviders;
  })();
  return priming;
}

/**
 * Resolve once the registry read has landed. The renderer pulls the provider map
 * exactly once at startup, so serving it a pre-prime snapshot would strand that
 * window on the seed for the whole session.
 */
export function whenOAuthProvidersReady(): Promise<ReadonlyMap<string, ProviderAuthCaps>> {
  return priming ?? primeOAuthProviders();
}

/** Does this provider offer a sign-in flow? True for dual-auth providers too. */
export function providerOffersSignIn(provider: string | undefined): boolean {
  return Boolean(provider && oauthProviders.has(provider));
}

/**
 * Does this provider authenticate ONLY by sign-in? Gates every "there is no API
 * key here" behavior: hiding the key field, masking `hasApiKey`, and skipping
 * key injection into the brain. Dual-auth providers must answer false.
 */
export function isOAuthOnlyProvider(provider: string | undefined): boolean {
  if (!provider) return false;
  const caps = oauthProviders.get(provider);
  return Boolean(caps && !caps.acceptsApiKey);
}

/** id -> auth capabilities, for the renderer's one-shot fetch. */
export function listOAuthProviders(): Record<string, ProviderAuthCaps> {
  return Object.fromEntries(oauthProviders);
}

function getAuthPath(): string {
  // Honor PI_CODING_AGENT_DIR so test/dev overrides land in the same place
  // the brain subprocess reads from. Mirrors bin/loom.js's agentDir resolution.
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = envDir
    ? envDir.replace(/^~(?=$|\/|\\)/, os.homedir())
    : path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "auth.json");
}

function readAuthFile(): Record<string, unknown> {
  const p = getAuthPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeAuthFile(data: Record<string, unknown>): void {
  const p = getAuthPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best-effort */
  }
}

export interface OAuthStatus {
  signedIn: boolean;
  /** Seconds until the access token expires. Negative if already expired -- the brain auto-refreshes. */
  expiresInSeconds?: number;
  accountId?: string;
}

export function getOAuthStatus(provider: string): OAuthStatus {
  const data = readAuthFile();
  const cred = data[provider] as
    { type?: string; expires?: number; accountId?: string } | undefined;
  if (!cred || cred.type !== "oauth") return { signedIn: false };
  const expiresInSeconds =
    typeof cred.expires === "number" ? Math.floor((cred.expires - Date.now()) / 1000) : undefined;
  return { signedIn: true, expiresInSeconds, accountId: cred.accountId };
}

export function signOutOAuth(provider: string): void {
  const data = readAuthFile();
  if (!(provider in data)) return;
  delete data[provider];
  writeAuthFile(data);
}

/**
 * Drive a provider's OAuth flow and persist the result to auth.json. Opens the
 * auth URL in the user's default browser; the provider's flow runs a local
 * callback server (127.0.0.1:1455 for OpenAI Codex) and returns once the
 * browser hands the code back.
 *
 * pi 0.81 folded the per-service `loginOpenAICodex()` helper into the provider
 * itself: auth now hangs off `provider.auth.oauth` as a login/refresh/toAuth
 * triple, and driving login is the app's job. Asking the runtime for the
 * provider is what makes this work for any of them rather than one by name.
 *
 * Throws if the flow fails (port conflict, user cancellation, network error).
 */
export async function signInOAuth(provider: string): Promise<OAuthStatus> {
  const runtime = await ModelRuntime.create({ authPath: getAuthPath() });
  const oauth = runtime.getProvider(provider)?.auth?.oauth;
  if (!oauth?.login) {
    throw new Error(`${provider} does not offer OAuth sign-in in this build of pi.`);
  }

  // pi 0.84 makes `signal` required on the provider login interaction. Orbit
  // has no cancel affordance for sign-in yet, so hand it one that never fires
  // rather than imply the flow is abortable.
  const abort = new AbortController();

  const creds = await oauth.login({
    signal: abort.signal,
    notify: (event) => {
      if (event.type === "auth_url") {
        void shell.openExternal(event.url);
        return;
      }
      if (event.type === "device_code") {
        // Device-code providers want the user to type a code on another page.
        // Orbit has no UI for that yet, so open the page and log the code
        // rather than silently appearing to hang.
        void shell.openExternal(event.verificationUri);
        console.log("[oauth] enter code:", event.userCode, "at", event.verificationUri);
        return;
      }
      if (event.type === "progress" || event.type === "info") {
        console.log("[oauth]", event.message);
      }
    },
    // pi 0.84 drives real decisions through `prompt`, not just the paste
    // fallback this used to assume, so rejecting outright fails every sign-in.
    prompt: async (request) => {
      // Codex now opens with a browser-vs-device-code chooser, so a blanket
      // reject dies before the browser ever opens. Orbit can open a URL but has
      // no chooser UI, so answer with the browser option -- the one flow it can
      // actually complete.
      if (request.type === "select") {
        // Don't fall back to whatever is first: the other methods are device-code
        // flows whose user code Orbit can only write to the console, which reads
        // to the user as a hang.
        const browser = request.options.find((o) => o.id === "browser");
        if (!browser) {
          throw new Error(
            `${provider} only offers login methods Orbit cannot complete yet ` +
              `(${request.options.map((o) => o.id).join(", ") || "none"}). Sign in with ` +
              `the pi CLI and Orbit will pick up the credentials.`,
          );
        }
        return browser.id;
      }

      // `manual_code` is raced against the local callback server, and the flow
      // treats a rejection here as fatal: its .catch sets manualError and calls
      // server.cancelWait(), and manualError is rethrown even when the callback
      // already won. Throwing immediately would therefore cancel the very browser
      // login we want. Wait instead and let the redirect win; pi aborts this
      // prompt's signal once it does.
      //
      // But don't wait forever. pi swallows a callback-port bind failure -- its
      // listen() error handler resolves a stub whose waitForCode() returns null --
      // so the flow falls straight through to `await manualPromise`, and this
      // prompt is the only thing still holding it. Never settling would hang
      // sign-in with no error at all, and since the flow's `finally` never runs,
      // the port stays bound and every retry hangs the same way. Time out instead
      // so the flow unwinds, closes its server, and reports something actionable.
      if (request.type === "manual_code") {
        return new Promise<string>((_resolve, reject) => {
          const cancel = (message: string) => {
            clearTimeout(timer);
            reject(new Error(message));
          };
          const timer = setTimeout(
            () =>
              cancel(
                `${provider} sign-in timed out waiting for the browser redirect. If ` +
                  `another app is holding the callback port (e.g. Codex CLI), quit it ` +
                  `and try again.`,
              ),
            SIGN_IN_TIMEOUT_MS,
          );
          request.signal?.addEventListener("abort", () => cancel("manual code entry cancelled"), {
            once: true,
          });
        });
      }

      // text/secret: a field Orbit genuinely cannot render yet.
      throw new Error(
        `${provider} needs input ("${request.message}") that Orbit cannot prompt ` +
          `for yet. Sign in with the pi CLI and Orbit will pick up the credentials.`,
      );
    },
  });

  const data = readAuthFile();
  data[provider] = {
    type: "oauth",
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    accountId: creds.accountId,
  };
  writeAuthFile(data);

  return getOAuthStatus(provider);
}
