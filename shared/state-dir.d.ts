export interface StateDirOptions {
  home?: string;
  migrate?: boolean;
}

export type StateDirMigrationStatus =
  "disabled" | "nothing-to-migrate" | "already-migrated" | "migrated" | "failed";

export const MIGRATE_TO_ORBIT_STATE_DIR: boolean;
export const MOVED_MARKER_FILE: string;

export function legacyStateDir(home?: string): string;
export function orbitStateDir(home?: string): string;
export function resolveStateDir(opts?: StateDirOptions): string;
export function resolveConfigPath(opts?: StateDirOptions): string;
export function resolveCliVersionCheckPath(opts?: StateDirOptions): string;
export function resolveDefaultAnalysesDir(opts?: StateDirOptions): string;
export function migrateStateDir(opts?: StateDirOptions & { enabled?: boolean; now?: Date }): {
  status: StateDirMigrationStatus;
  error?: unknown;
};
