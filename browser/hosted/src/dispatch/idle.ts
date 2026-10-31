/**
 * When a live worker should go (README decisions 9 and 17). A conversation with nothing running,
 * nothing asked and nobody watching for the quiet period gives its worker back; the next message
 * boots a fresh one from the store. A confirm nobody answers pauses the conversation instead of
 * holding a worker and the user's live loop until they come back; it's asked again then.
 */
export interface IdleSettings {
  /** How long a conversation sits quiet, with no page open on it, before its worker is released. */
  readonly releaseMs: number;
  /** How long a confirm may wait for an answer before the conversation pauses. */
  readonly askPauseMs: number;
}

export interface IdleState {
  /** A turn is running or a handler is busy with the conversation. */
  readonly busy: boolean;
  /** When the oldest unanswered ask was put to the user. */
  readonly oldestAskAt: number | undefined;
  /** A page has the conversation open. */
  readonly watched: boolean;
  /** Since when the conversation has been without a turn, an ask or a page. */
  readonly quietSince: number;
}

export type IdleAction = "pause" | "release" | undefined;

export function idleAction(state: IdleState, now: number, settings: IdleSettings): IdleAction {
  // An ask pauses whether or not a page is open: a tab left open overnight holds nothing either.
  if (state.oldestAskAt !== undefined) return now - state.oldestAskAt >= settings.askPauseMs ? "pause" : undefined;
  if (state.busy || state.watched) return undefined;
  return now - state.quietSince >= settings.releaseMs ? "release" : undefined;
}

/** How often to look: often enough that neither limit overshoots by much, never busier than 4 Hz. */
export function idleCheckMs(settings: IdleSettings): number {
  return Math.min(15_000, Math.max(250, Math.min(settings.releaseMs, settings.askPauseMs) / 4));
}
