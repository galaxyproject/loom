/**
 * The script that runs inside the frame, as source text.
 *
 * It is **not** a security boundary. It shares a realm with the agent-authored
 * content, which can overwrite `window.loom`, post its own messages, or lie
 * about its height. Everything it sends is re-validated on the host side. Its
 * only job is to be a convenient API for content that is behaving.
 *
 * Written as a string rather than a module because it has to be inlined into
 * the frame's document -- there is no origin it could be fetched from, and
 * fetching anything is exactly what the frame is not allowed to do.
 *
 * It announces itself once, over `window.postMessage`, and hands the host one
 * end of a `MessageChannel` with that announcement. Everything after that goes
 * over the port. A port belongs to the document that created it and dies with
 * it, so a document that replaces this one in the frame inherits nothing: the
 * host keeps posting into a port whose other end is gone rather than into
 * whatever is in the frame now.
 */

import { SANDBOX_MESSAGE_TAG, SANDBOX_MIN_HEIGHT, SANDBOX_MAX_HEIGHT } from "./policy.js";

/**
 * Kept deliberately small and dependency-free. `window.loom` gives content
 * three things: the data snapshot, a subscription that replays the last value
 * so registration order does not matter, and a way to ask for a height.
 */
export const SANDBOX_BRIDGE_SOURCE = `
(function () {
  "use strict";
  var TAG = ${JSON.stringify(SANDBOX_MESSAGE_TAG)};
  var MIN = ${SANDBOX_MIN_HEIGHT};
  var MAX = ${SANDBOX_MAX_HEIGHT};
  var listeners = [];
  var state = { data: null, dropped: [], updatedAt: 0 };

  var port = null;

  function post(message) {
    try {
      if (port) port.postMessage(message);
    } catch (err) {
      /* the parent may already be gone */
    }
  }

  function measure() {
    var doc = document.documentElement;
    var body = document.body;
    var h = Math.max(
      doc ? doc.scrollHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    );
    if (!isFinite(h)) return MIN;
    return Math.min(MAX, Math.max(MIN, Math.ceil(h)));
  }

  var lastSent = -1;
  var pending = false;
  function reportHeight() {
    if (pending) return;
    pending = true;
    var run = function () {
      pending = false;
      var h = measure();
      if (h === lastSent) return;
      lastSent = h;
      post({ tag: TAG, type: "height", height: h });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function deliver() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](state.data, state);
      } catch (err) {
        /* one bad handler must not stop the others */
      }
    }
    reportHeight();
  }

  function receive(event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object" || msg.tag !== TAG) return;
    if (msg.type !== "data") return;
    state = {
      data: msg.sources || {},
      dropped: msg.dropped || [],
      updatedAt: msg.updatedAt || Date.now(),
    };
    deliver();
    try {
      window.dispatchEvent(new CustomEvent("loom:data", { detail: state }));
    } catch (err) {
      /* CustomEvent is present everywhere we run, but never take the frame down for it */
    }
  }

  window.loom = {
    get data() {
      return state.data;
    },
    get dropped() {
      return state.dropped;
    },
    onData: function (fn) {
      if (typeof fn !== "function") return;
      listeners.push(fn);
      // Replay, so content does not have to care whether it registered before
      // or after the first snapshot arrived.
      if (state.data) {
        try {
          fn(state.data, state);
        } catch (err) {
          /* as above */
        }
      }
    },
    resize: reportHeight,
  };

  if (typeof ResizeObserver === "function") {
    try {
      new ResizeObserver(reportHeight).observe(document.documentElement);
    } catch (err) {
      /* fall back to the explicit calls below */
    }
  }
  window.addEventListener("load", reportHeight);
  document.addEventListener("DOMContentLoaded", reportHeight);

  // The announcement is the one thing that has to go over the window, because
  // there is no port yet. It carries the port, and it happens while the head
  // is still parsing -- before any content, any content script, or any
  // meta refresh in the body has had a chance to run. So this
  // document always claims the channel first, and the host can treat a second
  // announcement as a document that is not this one.
  try {
    var channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = receive;
    parent.postMessage({ tag: TAG, type: "ready" }, "*", [channel.port2]);
  } catch (err) {
    /* no channel, no data -- the view still draws whatever it can draw */
  }
})();
`;
