/**
 * Embed-token bridge — drives the embed-token lifecycle from notebook state and
 * pushes each minted token to the shell on the dedicated `EmbedToken` widget
 * key. The shell's privileged process (Orbit main) intercepts that key and never
 * forwards it to the renderer (see shared/loom-shell-contract.js); a shell with
 * no interceptor (the Loom CLI) ignores it.
 *
 * Kept separate from ui-bridge.ts: that module owns user-facing widgets; this
 * one owns a secret that must not be treated like display content. Both react to
 * the same `onNotebookChange` stream.
 *
 * A token is only useful while the notebook is bound *and* connected to Galaxy,
 * so the manager is pointed at the page only then; otherwise it's unbound, which
 * cancels any pending refresh and clears the held token.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onNotebookChange, isGalaxyEffectivelyConnected, readCurrentNotebook } from "./state.js";
import { LoomWidgetKey, encodeEmbedToken } from "../../shared/loom-shell-contract.js";
import { findGalaxyPageBlocks } from "./galaxy-page-binding.js";
import {
  createEmbedTokenManager,
  type EmbedTokenManager,
  type EmbedTokenManagerOptions,
} from "./embed-token-manager.js";

export interface EmbedTokenBridgeOptions {
  /** Mint override forwarded to the manager (injected for tests). */
  mint?: EmbedTokenManagerOptions["mint"];
}

export function setupEmbedTokenBridge(pi: ExtensionAPI, opts: EmbedTokenBridgeOptions = {}): void {
  let latestCtx: ExtensionContext | null = null;

  const manager: EmbedTokenManager = createEmbedTokenManager({
    mint: opts.mint,
    sink: (update) => {
      if (!latestCtx) return;
      try {
        latestCtx.ui.setWidget(LoomWidgetKey.EmbedToken, encodeEmbedToken(update));
      } catch (err) {
        // Same late-firing stale-ctx case as ui-bridge (#271): drop the ctx and
        // no-op rather than spamming stderr; surface anything else.
        if (!(err instanceof Error && /ctx is stale/i.test(err.message))) {
          console.error("embed token widget update failed:", err);
        }
        latestCtx = null;
      }
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    latestCtx = ctx;
  });

  // Resume gap (Bug 3): mint for an already-bound notebook (e.g. a `--continue`
  // resume) without waiting for a notebook write. `initSessionArtifacts` already
  // replays via `notifyNotebookChange` on session_start, but the mint sink needs
  // a captured ctx to deliver — so capture it here. The explicit
  // `pointAtNotebook(readCurrentNotebook())` is the order-independent belt vs.
  // init's replay; `setPage` no-ops when already on that page, so whichever
  // fires first wins and the other is a no-op (no double mint).
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    const content = readCurrentNotebook();
    if (content !== null) pointAtNotebook(content);
  });

  function pointAtNotebook(content: string): void {
    const binding = findGalaxyPageBlocks(content)[0] ?? null;
    // Only mint while bound AND connected — minting needs the API key + a live
    // server, and a token is worthless without a page to embed.
    manager.setPage(binding && isGalaxyEffectivelyConnected() ? binding.pageId : null);
  }

  onNotebookChange(pointAtNotebook);
}
