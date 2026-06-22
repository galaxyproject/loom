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
  COOKIE_HEADER,
  EMBED_TOKEN_HEADER,
  GALAXY_EMBED_PARTITION,
  SET_COOKIE_HEADER,
  sameGalaxyOrigin,
  shouldBlockNavigation,
  stripFrameHeaders,
  stripHeader,
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
    let headers = { ...details.requestHeaders };
    const token = deps.getToken();
    if (token && sameGalaxyOrigin(details.url, deps.getServerUrl())) {
      headers[EMBED_TOKEN_HEADER] = token;
      // Keep the partition stateless: drop any ambient `galaxysession` cookie so
      // Galaxy authenticates by the embed token alone (LOOM Bug 1) — otherwise
      // the anonymous cookie session wins and the token is ignored.
      headers = stripHeader(headers, COOKIE_HEADER);
    } else {
      delete headers[EMBED_TOKEN_HEADER];
    }
    callback({ requestHeaders: headers });
  });

  sess.webRequest.onHeadersReceived((details, callback) => {
    if (sameGalaxyOrigin(details.url, deps.getServerUrl())) {
      // Strip frame-busting headers AND `Set-Cookie` so Galaxy can't seat a
      // session in the embed partition (the request-side cookie strip already
      // neuters it; this keeps the cookie jar clean — LOOM Bug 1).
      const stripped = stripHeader(
        stripFrameHeaders(details.responseHeaders ?? undefined),
        SET_COOKIE_HEADER,
      );
      callback({ responseHeaders: stripped });
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
