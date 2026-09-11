/**
 * The wire shape for a server -> shim agent event, and its inverse.
 *
 * The server pushes events with a variadic signature (`sendEvent("agent:status",
 * "error", message)`) and the renderer receives them through a variadic callback
 * (`onAgentStatus((status, msg) => ...)`). Between the two sits one JSON field,
 * so the encoding has to survive the round trip for any argument count.
 *
 * It didn't. The old format sent a bare value for one argument and a raw array
 * for more, and the shim passed whatever it got as a single argument. One-arg
 * events worked; multi-arg events arrived as one array, which the renderer
 * stringified into the status pill as "error,No LLM provider is configured..."
 * (#439). A single-element array had been papering over it, since that
 * stringifies to exactly its element.
 */

/** Pack the variadic args of one event into the `_payload` wire field. */
export function encodeEventPayload(payload: unknown[]): unknown[] {
  return payload;
}

/**
 * Unpack `_payload` back into an argument list.
 *
 * Tolerates the old bare-value form so a browser holding a stale bundle -- or a
 * shim newer than the server it reconnects to -- degrades to the previous
 * behavior instead of spreading a string into individual characters.
 */
export function decodeEventPayload(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [raw];
}
