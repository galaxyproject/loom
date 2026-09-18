/**
 * Custom view -- an agent-authored HTML view in a locked-down iframe.
 *
 * This is the one widget with a real security surface, and it is off by
 * default. The content is written by the agent, the agent can be
 * prompt-injected by anything it reads, and the content is persisted in
 * `.loom-dashboard.json` so it runs again every time the analysis is opened.
 * It is therefore treated as hostile, permanently.
 *
 * What holds it:
 *  - `sandbox="allow-scripts"` and nothing else. No `allow-same-origin`, so
 *    the frame has an opaque origin and cannot reach our DOM, our
 *    `localStorage` or `window.orbit`, and cannot rewrite its own sandbox.
 *  - a `default-src 'none'` CSP as the first element of the document, so no
 *    fetch, no XHR, no WebSocket, no image beacon, no nested frame.
 *  - a check, before anything is drawn, that the embedding page's `frame-src`
 *    pins this frame to sources that cannot reach the network. That is the
 *    only thing that stops a document navigating *itself*, which is a request
 *    with the content's own data in the URL -- and if the far end answers 204
 *    the frame does not even change, so nothing here could notice after the
 *    fact. It is a directive in a file this widget does not own, so it is
 *    verified at runtime rather than assumed.
 *  - data in and out only over a `MessageChannel` the frame's own document
 *    hands us once, when it announces itself. A port belongs to the document
 *    that created it, so a document that later replaces ours in the frame
 *    inherits nothing and we never post to it. Only the sources the panel's
 *    `data` config named are sent, and a source that was not named is never
 *    even subscribed to.
 *  - the only thing that comes back is a height, validated, clamped and rate
 *    limited.
 *
 * What does not hold it, and is written down rather than hidden: the content
 * can draw anything it likes inside its own box, including something that
 * looks like Orbit asking for a password. Nothing here stops that; the badge
 * and the inset edge are all a user has to tell the difference with. Nor is
 * there anything here that stops a view burning the main thread in a loop.
 */

import type { WidgetDefinition, WidgetDispose } from "../widget-api.js";
import {
  SANDBOX_MAX_HTML_BYTES,
  SANDBOX_READY_TIMEOUT_MS,
  SANDBOX_TOKENS,
} from "../sandbox/policy.js";
import { buildSandboxDocument } from "../sandbox/srcdoc.js";
import { buildDataMessage, MessageBudget, readFrameMessage } from "../sandbox/protocol.js";
import {
  allowedDataSources,
  byteLength,
  collectSandboxData,
  resolveAllowedSources,
} from "../sandbox/data-snapshot.js";
import { isHtmlSandboxEnabled } from "../sandbox/flag.js";
import { checkHostFramePolicy } from "../sandbox/host-policy.js";

type HtmlSandboxConfig = {
  /** The markup to render. Treated as hostile. */
  html: string;
  /** The frame's document title. The panel's own title still comes from the layout. */
  title?: string;
  /** Which data sources the content may receive. Empty means none. */
  data?: string[];
};

/** Coalesce a burst of source updates into one message. */
const DATA_DEBOUNCE_MS = 150;

function currentTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function card(title: string, detail: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "dash-card";
  const heading = document.createElement("p");
  heading.className = "dash-card-title";
  heading.textContent = title;
  const body = document.createElement("p");
  body.className = "dash-card-detail";
  body.textContent = detail;
  box.append(heading, body);
  return box;
}

export const htmlSandboxWidget: WidgetDefinition<HtmlSandboxConfig> = {
  type: "html-sandbox",
  label: "Custom view",
  description: "An agent-authored view in a locked-down iframe. Behind a flag.",
  defaultConfig: { html: "", data: [] },

  mount(el, ctx): WidgetDispose {
    // The badge goes up whatever happens next, including the disabled and
    // refused paths: "this panel's content did not come from us" is true in
    // all of them.
    const badge = document.createElement("span");
    badge.className = "dash-sandbox-badge";
    badge.textContent = "custom content";
    badge.title =
      "This view was written by the agent, not by Orbit. It runs in a locked-down frame that " +
      "cannot reach the rest of Orbit and cannot fetch anything.";
    ctx.header.append(badge);

    const wrap = document.createElement("div");
    wrap.className = "dash-sandbox";
    el.append(wrap);

    const clearNote = (): void => {
      if (floodNoted || navigated) return;
      wrap.querySelector(".dash-sandbox-note")?.remove();
    };

    const note = (text: string, alarm = false): void => {
      let line = wrap.querySelector<HTMLElement>(".dash-sandbox-note");
      if (!line) {
        line = document.createElement("p");
        line.className = "dash-sandbox-note";
        wrap.prepend(line);
      }
      line.classList.toggle("dash-sandbox-alarm", alarm);
      line.textContent = text;
    };

    if (!isHtmlSandboxEnabled()) {
      wrap.append(
        card(
          "Custom views are switched off",
          "The agent can write a small view for this panel, and it would run with no network access " +
            "and no way to reach the rest of Orbit. It stays switched off until that has been " +
            "reviewed, so nothing here has run.",
        ),
      );
      return () => {
        el.textContent = "";
      };
    }

    const html = typeof ctx.config.html === "string" ? ctx.config.html : "";
    if (!html.trim()) {
      wrap.append(
        card(
          "Nothing to show yet",
          "This panel is waiting for a view. Ask the agent for the picture you want -- a plot of a " +
            "result, a summary of where the run is -- and it will write one here.",
        ),
      );
      return () => {
        el.textContent = "";
      };
    }

    const size = byteLength(html);
    if (size > SANDBOX_MAX_HTML_BYTES) {
      wrap.append(
        card(
          "This view is too large to open",
          `It is ${Math.round(size / 1024)} KB and the limit is ${Math.round(
            SANDBOX_MAX_HTML_BYTES / 1024,
          )} KB. Nothing was run. Ask the agent for a smaller view.`,
        ),
      );
      return () => {
        el.textContent = "";
      };
    }

    // Checked here, after the size cap and before the frame exists, so a page
    // whose policy would let a view beacon out never gets one drawn.
    const hostPolicy = checkHostFramePolicy();
    if (!hostPolicy.contained) {
      wrap.append(
        card(
          "This view was not run",
          "Orbit's own content rules would not stop a custom view from reaching the network " +
            "from inside its frame, so nothing here has been run. This is a problem with the " +
            "build rather than with your analysis." +
            (hostPolicy.offending.length > 0
              ? ` The frame rule in force is "${hostPolicy.effective}".`
              : " No content rules were found on the page at all."),
        ),
      );
      return () => {
        el.textContent = "";
      };
    }

    const allowed = resolveAllowedSources(ctx.config.data);

    const stage = document.createElement("div");
    stage.className = "dash-sandbox-stage";
    wrap.append(stage);

    const frame = document.createElement("iframe");
    frame.className = "dash-sandbox-frame";
    frame.setAttribute("sandbox", SANDBOX_TOKENS);
    // An empty container policy: it delegates nothing. It is not a blanket
    // deny -- an unnamed feature still falls back to its own default
    // allowlist -- so the thing actually keeping the camera and the rest away
    // is the opaque origin. This is here so that delegating something later
    // has to be a deliberate edit.
    frame.setAttribute("allow", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", "Agent-authored custom view");
    frame.style.height = "100%";

    let disposed = false;
    let loads = 0;
    let navigated = false;
    let floodNoted = false;
    let port: MessagePort | null = null;
    const budget = new MessageBudget();

    const dropPort = (): void => {
      try {
        port?.close();
      } catch {
        /* closing a port whose other end is already gone is not interesting */
      }
      port = null;
    };
    ctx.onDispose(dropPort);

    const send = (): void => {
      if (disposed || navigated || !port) return;
      const payload = collectSandboxData(ctx.sources, allowed);
      // Over the port, not over the window. The window would deliver to
      // whatever document is in the frame now; the port only reaches the one
      // that opened it.
      port.postMessage(buildDataMessage(payload));
      if (payload.dropped.length > 0) {
        note(
          `Some data was too large to hand to this view, so it was left out: ${payload.dropped.join(", ")}.`,
        );
      } else {
        clearNote();
      }
    };

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const sendSoon = (): void => {
      if (debounce !== null) return;
      debounce = setTimeout(() => {
        debounce = null;
        send();
      }, DATA_DEBOUNCE_MS);
    };
    ctx.onDispose(() => {
      if (debounce !== null) clearTimeout(debounce);
    });

    /**
     * The frame is allowed to navigate itself -- no CSP directive covers a
     * script assigning `location`, and a meta refresh does it with no script
     * at all. Whether the app's own `frame-src` stops that is the app's
     * business and can change.
     *
     * This is a **detector, not a defence**, and the difference matters. A
     * `load` event arrives only once the replacing document has finished
     * loading, long after its own head script could have run, so by the time
     * this fires the navigation has already happened or already been refused.
     * What keeps data away from the replacing document is the port, which
     * belongs to the document that opened it. This exists to say out loud that
     * something abnormal happened.
     */
    const suspectTakeover = (): void => {
      if (navigated || disposed) return;
      navigated = true;
      dropPort();
      frame.remove();
      note(
        "This view tried to open a web page. Orbit has stopped talking to it. " +
          "That is not something a normal view does -- it is worth telling whoever set this up.",
        true,
      );
    };

    const onLoad = (): void => {
      loads += 1;
      if (loads <= 1) return;
      suspectTakeover();
    };
    frame.addEventListener("load", onLoad);
    ctx.onDispose(() => frame.removeEventListener("load", onLoad));

    const overBudget = (): boolean => {
      if (budget.allow()) return false;
      if (!floodNoted) {
        floodNoted = true;
        note(
          "This view is asking for more than its share of attention, so some of what it " +
            "sends is being ignored. What you can see is still correct.",
        );
      }
      return true;
    };

    /** Everything after the announcement arrives here, on the frame's own port. */
    const onPortMessage = (event: MessageEvent): void => {
      if (disposed || navigated) return;
      if (overBudget()) return;
      const msg = readFrameMessage(event.data);
      if (!msg || msg.type !== "height") return;
      frame.style.height = `${msg.height}px`;
    };

    /**
     * The only thing accepted over the window is the announcement, and only
     * once. Our bridge sends it while the frame's head is still parsing, so it
     * always gets there before anything in the body could have navigated --
     * which means a second announcement is a second document, not a retry.
     */
    const onMessage = (event: MessageEvent): void => {
      if (disposed || navigated) return;
      // Identity, not origin: an opaque-origin frame posts with origin "null",
      // which every other opaque frame on the page would also match.
      if (!frame.contentWindow || event.source !== frame.contentWindow) return;
      if (overBudget()) return;
      const msg = readFrameMessage(event.data);
      if (!msg || msg.type !== "ready") return;
      // Only the first announcement is honoured. A second one is ignored in
      // silence rather than raising the alarm: content sharing a realm with
      // the bridge can send one whenever it likes, and an alarm anybody can
      // fire is an alarm nobody reads. What keeps a replacing document away
      // from the data is that it does not get a port, not that we shout.
      if (port) return;
      const offered = event.ports?.[0];
      if (!offered) return;
      port = offered;
      port.onmessage = onPortMessage;
      send();
    };
    window.addEventListener("message", onMessage);
    ctx.onDispose(() => window.removeEventListener("message", onMessage));

    // Only subscribe to what the panel asked for: a source that is not in
    // `data` is never read, so it cannot reach the frame by any path.
    for (const source of allowedDataSources(ctx.sources, allowed)) {
      ctx.subscribe(source, () => sendSoon(), { immediate: false });
    }

    // srcdoc before append, so the frame loads our document once rather than
    // loading about:blank first and tripping the watchdog.
    frame.srcdoc = buildSandboxDocument({
      html,
      title: ctx.config.title,
      theme: currentTheme(),
    });
    stage.append(frame);

    /**
     * Orbit's own CSP is inherited by a `srcdoc` frame, and its
     * `script-src 'self'` blocks every inline script in this one -- the bridge
     * included, and inline handler attributes too. **As the app is built
     * today that is not an edge case, it is what always happens**, so a view
     * with moving parts is always a still picture and the data channel never
     * opens. Giving the frame a document over a scheme that does not inherit
     * is the fix, and it is a main-process change.
     *
     * Until then, say so: the content still renders, and a silent still
     * picture is worse than one that explains itself. Only worth saying for a
     * view that has a script to lose.
     */
    const readyTimer = setTimeout(() => {
      if (disposed || port || navigated) return;
      if (!/<script[\s>]/i.test(html)) return;
      note(
        "The moving parts of this view are switched off by Orbit's content policy, so it is " +
          "showing as a still picture. Everything it can draw is drawn.",
      );
    }, SANDBOX_READY_TIMEOUT_MS);
    ctx.onDispose(() => clearTimeout(readyTimer));

    // A theme flip has to reach the frame, and the frame cannot see our CSS
    // variables. Rebuilding is the one path that works whether or not its
    // scripts are running.
    let theme = currentTheme();
    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver(() => {
        const next = currentTheme();
        if (next === theme || disposed || navigated) return;
        theme = next;
        // A rebuild is a new document, so it is a new load and a new port. The
        // load counter has to be reset or the rebuild would read as a takeover.
        loads = 0;
        dropPort();
        frame.srcdoc = buildSandboxDocument({ html, title: ctx.config.title, theme });
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      ctx.onDispose(() => observer.disconnect());
    }

    return () => {
      disposed = true;
      frame.remove();
      el.textContent = "";
    };
  },
};
