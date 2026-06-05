export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}
export function parseSemver(v: string): SemverParts | null;
export function comparePre(a: string, b: string): number;
export function isNewer(current: string, candidate: string): boolean;
export function pickChannel(version: string): string;
