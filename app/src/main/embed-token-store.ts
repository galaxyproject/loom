/**
 * Holds the current Galaxy embed token in the privileged main process.
 *
 * The brain pushes the token on the dedicated `EmbedToken` widget key; main
 * intercepts that key (see agent.ts handleLine) and parks the value here instead
 * of forwarding it to the renderer. The locked-down iframe partition reads the
 * current token from this store when injecting the `X-Galaxy-Embed-Token` header
 * (wired in the partition step). The renderer never sees the token.
 *
 * Deliberately electron-free so it can be unit-tested from the root test suite,
 * which can't import modules that pull in `electron`.
 */

import {
  LoomWidgetKey,
  decodeEmbedToken,
  type EmbedTokenWidgetPayload,
} from "../../../shared/loom-shell-contract.js";

/**
 * If `data` is a brain `setWidget` request on the EmbedToken key, decode and
 * return its payload; otherwise return null. Returning null means "not a token
 * widget — forward it to the renderer as usual." A malformed token payload also
 * returns null (nothing to store), but callers should still treat a matched key
 * as consumed — see `isEmbedTokenWidget`.
 */
export function parseEmbedTokenWidget(
  data: Record<string, unknown>,
): EmbedTokenWidgetPayload | null {
  if (!isEmbedTokenWidget(data)) return null;
  try {
    return decodeEmbedToken(data.widgetLines as string[] | undefined);
  } catch {
    return null;
  }
}

/**
 * True when `data` is a `setWidget` request on the EmbedToken key, regardless of
 * whether the payload decodes. Main uses this to decide whether to swallow the
 * message (never forward a token to the renderer, even a malformed one).
 */
export function isEmbedTokenWidget(data: Record<string, unknown>): boolean {
  return data.method === "setWidget" && data.widgetKey === LoomWidgetKey.EmbedToken;
}

export type EmbedTokenListener = (token: EmbedTokenWidgetPayload | null) => void;

export class EmbedTokenStore {
  private current: EmbedTokenWidgetPayload | null = null;
  private listeners: EmbedTokenListener[] = [];

  get(): EmbedTokenWidgetPayload | null {
    return this.current;
  }

  set(token: EmbedTokenWidgetPayload): void {
    this.current = token;
    this.emit();
  }

  clear(): void {
    if (this.current === null) return;
    this.current = null;
    this.emit();
  }

  /** Subscribe to token changes (e.g. to reconfigure the partition). Returns an
   *  unsubscribe. */
  onChange(listener: EmbedTokenListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}
