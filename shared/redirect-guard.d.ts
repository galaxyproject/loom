export type RedirectRefusalKind = "cross-origin" | "unreadable" | "unparsable" | "too-many-hops";

export declare class RedirectRefusedError extends Error {
  readonly kind: RedirectRefusalKind;
  readonly status: number;
  readonly fromOrigin: string;
  readonly toOrigin: string | null;
  constructor(
    message: string,
    detail: {
      kind: RedirectRefusalKind;
      status: number;
      fromOrigin: string;
      toOrigin?: string | null;
    },
  );
}

export declare function originOf(url: string): string | null;

export interface SameOriginFetchOptions {
  /** Defaults to `globalThis.fetch`, resolved per call. */
  fetchImpl?: typeof fetch;
  /** Same-origin hops to allow before giving up. Default 3. */
  maxHops?: number;
  /** How the server is named in error messages. Default "The server". */
  serverLabel?: string;
  /** How the URL setting is named in error messages. Default "the configured URL". */
  urlSettingLabel?: string;
}

export declare function fetchSameOriginOnly(
  url: string,
  init?: RequestInit,
  options?: SameOriginFetchOptions,
): Promise<Response>;
