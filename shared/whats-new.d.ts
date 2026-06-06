// Types for the shell-neutral what's-new logic. Impl is shared/whats-new.js.
export interface WhatsNewEntry {
  version: string;
  date?: string;
  highlights: string[];
}

export interface WhatsNewDecision {
  /** New lastSeen to persist, or null to leave the stamp unchanged. */
  stamp: string | null;
  /** Entries to display (possibly empty). */
  entries: WhatsNewEntry[];
}

export type WhatsNewMode = "accumulate" | "latest";

export function parseChangelog(markdown: string): WhatsNewEntry[];
export function selectEntries(
  all: WhatsNewEntry[],
  lastSeen: string | undefined,
  running: string,
  mode: WhatsNewMode,
): WhatsNewEntry[];
export function decideWhatsNew(
  all: WhatsNewEntry[],
  lastSeen: string | undefined,
  running: string,
  mode: WhatsNewMode,
): WhatsNewDecision;
export function releaseUrlFor(version: string): string;
export function formatHighlightsText(entries: WhatsNewEntry[]): string;
