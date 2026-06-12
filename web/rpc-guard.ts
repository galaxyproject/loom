/**
 * Guards for what the web shell is allowed to forward onto the brain's RPC
 * stdin. The brain trusts everything on its stdin: pi's RPC dispatcher routes
 * each line by `command.type`, and its `bash` command type calls executeBash()
 * DIRECTLY -- it never emits a `tool_call` event, so the web-mode-gate (which
 * only hooks tool_call) never sees it.
 *
 * The browser is the untrusted party in the remote/container threat model, and
 * the only client message that legitimately reaches stdin verbatim is an
 * extension UI response (over the `agent:ui-response` channel). If the server
 * forwarded that channel's payload unconditionally, a client could inject
 * `{type:"bash", command:"env"}` and run arbitrary shell in the container,
 * exfiltrating the env-injected Galaxy + LLM keys. So the server forwards a
 * ui-response payload only when this guard accepts it.
 */
export function isForwardableUiResponse(payload: unknown): payload is Record<string, unknown> {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { type?: unknown }).type === "extension_ui_response"
  );
}
