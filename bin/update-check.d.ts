// Mirrors the discriminated union in update-check.js: a failure entry carries
// no latest/channel; a success entry requires both.
export type Cache =
  | { fetchedAt: number; failed: true }
  | { fetchedAt: number; failed?: false; latest: string; channel: string };
export function getLoomVersion(): string;
export function parseCache(raw: string, now: number): Cache | null;
export function noticeFor(current: string, cache: Cache | null): string | null;
export function readCache(): Cache | null;
export function readNotice(): string | null;
export function refreshCache(): Promise<void>;
export function detectInstall(channel: string): {
  kind: "global" | "local" | "unknown";
  cmd: string | null;
};
