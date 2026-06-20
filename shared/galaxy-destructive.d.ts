export type GalaxyDestructiveKind =
  | "history-delete"
  | "history-purge"
  | "dataset-delete"
  | "dataset-purge"
  | "collection-delete"
  | "collection-purge";
export interface GalaxyDestructiveOp {
  kind: GalaxyDestructiveKind;
  historyId?: string;
  datasetId?: string;
  collectionId?: string;
  irreversible: boolean;
}
export function classifyGalaxyDestructive(
  toolName: string,
  input: Record<string, unknown>,
): GalaxyDestructiveOp | null;
export function describeGalaxyDestructive(op: GalaxyDestructiveOp): { headline: string };
export function isGalaxyDestructiveCurl(command: string): GalaxyDestructiveOp | null;
