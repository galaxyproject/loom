/**
 * Electron wiring for the locked-down Galaxy embed iframe partition.
 *
 * Plumbs Electron's webRequest hooks into the pure trust-boundary predicates in
 * embed-partition.ts:
 *   - onBeforeSendHeaders: inject `X-Galaxy-Embed-Token` for Galaxy-origin
 *     requests only; strip it everywhere else (defensive against a stale header
 *     riding to another host).
 *   - onHeadersReceived: drop frame-busting headers on Galaxy-origin responses.
 *   - onBeforeRequest: block main/sub-frame navigations off the Galaxy origin.
 *
 * The token + server URL are read live via injected getters so a refreshed
 * token (galaxy-embed token manager) or a reconnect is picked up without
 * re-registering hooks. Imports Electron, so it is kept out of the pure module
 * (and the root test suite, which can't load Electron).
 */

import { session, type Session } from "electron";
import {
  EMBED_TOKEN_HEADER,
  GALAXY_EMBED_PARTITION,
  sameGalaxyOrigin,
  shouldBlockNavigation,
  stripFrameHeaders,
} from "./embed-partition.js";

export interface EmbedPartitionDeps {
  /** Current embed token, or null when none is held. */
  getToken: () => string | null;
  /** Effective Galaxy server URL, or null when not connected. */
  getServerUrl: () => string | null;
}

/**
 * Configure (and return) the dedicated embed partition's session. `sess`
 * defaults to the real partition; tests/callers may pass a stub session.
 */
export function configureGalaxyEmbedPartition(
  deps: EmbedPartitionDeps,
  sess: Session = session.fromPartition(GALAXY_EMBED_PARTITION),
): Session {
  sess.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    const token = deps.getToken();
    if (token && sameGalaxyOrigin(details.url, deps.getServerUrl())) {
      headers[EMBED_TOKEN_HEADER] = token;
    } else {
      delete headers[EMBED_TOKEN_HEADER];
    }
    callback({ requestHeaders: headers });
  });

  sess.webRequest.onHeadersReceived((details, callback) => {
    if (sameGalaxyOrigin(details.url, deps.getServerUrl())) {
      callback({ responseHeaders: stripFrameHeaders(details.responseHeaders ?? undefined) });
    } else {
      callback({ cancel: false });
    }
  });

  sess.webRequest.onBeforeRequest((details, callback) => {
    const isNavigation =
      details.resourceType === "mainFrame" || details.resourceType === "subFrame";
    if (isNavigation && shouldBlockNavigation(details.url, deps.getServerUrl())) {
      callback({ cancel: true });
    } else {
      callback({ cancel: false });
    }
  });

  return sess;
}
