/**
 * Whether the agent-authored HTML widget is switched on.
 *
 * **Off, as a constant, and there is no way to turn it on in this build.**
 *
 * It used to read `localStorage["orbit.experiments.htmlSandbox"]`, which put the
 * flag inside the agent's reach in a packaged desktop build. The renderer is
 * loaded with `loadFile`, so its origin is `file://`, and every `file://`
 * document shares one localStorage bucket. The agent can write an `.html` into
 * the analysis directory without a prompt, the file viewer offers "Open
 * Externally" on it, and that window is `file://` with no CSP and live scripts.
 * One click and `localStorage.setItem("orbit.experiments.htmlSandbox", "1")`
 * turns the feature on for good. The threat model said "nothing the agent can
 * write can turn it on"; that was the intent and it was not true.
 *
 * `window.__ORBIT_EXPERIMENTS__` is no better on its own: nothing sets it, and
 * anything running in the renderer can. A flag that gates a security boundary
 * has to come from somewhere neither the agent nor the renderer can write.
 *
 * **What would have to be built.** The shell would have to resolve
 * `LOOM_HTML_SANDBOX` / `config.experiments.htmlSandbox` in a process the agent
 * cannot write to, and hand the answer to the renderer over a channel the page
 * cannot forge -- the preload bridge in Electron, the socket handshake in the
 * web shell. That is main-process work and it is deliberately not done here,
 * because the scripted version of this widget does not work under Orbit's CSP
 * anyway (see the threat model note) and would need its own origin before any
 * of this matters.
 *
 * Until then this returns false and the widget draws its "switched off" card.
 * The registry still knows the type, so a layout carrying one of these panels
 * survives a round trip instead of losing it.
 */

/** The env var / config key a shell would map onto the flag, when one does. */
export const HTML_SANDBOX_ENV = "LOOM_HTML_SANDBOX";

/**
 * Test-only override, so the drawing code below the flag stays exercised.
 *
 * Deliberately a function call and not a stored value: the hole this replaced
 * was that the flag lived in `localStorage`, which a *different* `file://`
 * document -- one the agent wrote and the user opened -- could set, and which
 * survived a restart. Calling this needs code already running inside the
 * renderer module graph, which is a bar an attacker who has cleared it has
 * already won past. Nothing in production calls it.
 */
let testOverride: boolean | null = null;

export function __setHtmlSandboxEnabledForTests(value: boolean | null): void {
  testOverride = value;
}

export function isHtmlSandboxEnabled(): boolean {
  if (testOverride !== null) return testOverride;
  return false;
}
