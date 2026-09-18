/**
 * The two messages that cross the frame boundary, and the validation that
 * makes the inbound one safe to act on.
 *
 * Out of the frame there is exactly one thing: a request for a height. It is
 * the whole return channel on purpose -- anything richer is a channel the
 * content can use to drive the host, and there is no view that needs one.
 */

import {
  SANDBOX_MAX_HEIGHT,
  SANDBOX_MAX_MESSAGES_PER_SECOND,
  SANDBOX_MESSAGE_TAG,
  SANDBOX_MIN_HEIGHT,
} from "./policy.js";
import type { SandboxDataPayload } from "./data-snapshot.js";

export type SandboxFrameMessage = { type: "ready" } | { type: "height"; height: number };

export interface SandboxDataMessage {
  tag: typeof SANDBOX_MESSAGE_TAG;
  type: "data";
  sources: Record<string, unknown>;
  dropped: string[];
  updatedAt: number;
}

export function buildDataMessage(payload: SandboxDataPayload): SandboxDataMessage {
  return {
    tag: SANDBOX_MESSAGE_TAG,
    type: "data",
    sources: payload.sources,
    dropped: payload.dropped,
    updatedAt: Date.now(),
  };
}

export function clampHeight(value: number): number {
  return Math.min(SANDBOX_MAX_HEIGHT, Math.max(SANDBOX_MIN_HEIGHT, Math.round(value)));
}

/**
 * Anything that is not one of the two known messages is dropped without
 * comment. The frame's content is hostile by assumption, so this reads every
 * field defensively rather than destructuring a shape it hopes is there.
 */
export function readFrameMessage(data: unknown): SandboxFrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  // Own properties only. `postMessage` structured-clones, so a real message
  // never carries an interesting prototype -- but this is also called
  // directly, and a field that is not there should read as not there.
  const own = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(msg, key) ? msg[key] : undefined;

  if (own("tag") !== SANDBOX_MESSAGE_TAG) return null;

  const type = own("type");
  if (type === "ready") return { type: "ready" };

  if (type === "height") {
    const raw = own("height");
    // Guard the type before the arithmetic: `Math.round("40")` is 40, and a
    // string that coerces is exactly the sort of thing a hostile frame sends.
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    return { type: "height", height: clampHeight(raw) };
  }

  return null;
}

/**
 * A frame that posts in a tight loop is a way to burn the renderer's main
 * thread, which is the one resource the sandbox cannot take away from it.
 * A fixed budget per rolling second is cruder than a token bucket and easier
 * to be sure of.
 */
export class MessageBudget {
  private windowStart = 0;
  private count = 0;

  constructor(
    private limit: number = SANDBOX_MAX_MESSAGES_PER_SECOND,
    private now: () => number = () => Date.now(),
  ) {}

  /** True when this message is within budget. */
  allow(): boolean {
    const t = this.now();
    if (t - this.windowStart >= 1000) {
      this.windowStart = t;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit;
  }
}
