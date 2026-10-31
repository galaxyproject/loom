export const MANIFEST_MAX: number;
export function historyContentsPath(historyId: string): string;
export function historyManifestBlock(listed: { items?: unknown; error?: unknown }): string;
export function historyBindingBlock(
  historyId: string,
  manifest: string,
  options?: { shown?: boolean },
): string;
