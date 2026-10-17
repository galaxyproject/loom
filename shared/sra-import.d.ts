export type NormalizeName = (
  name: string,
  args: Record<string, unknown>,
) => { name: string; args: Record<string, unknown> } | null;
export interface SraCall {
  key: string;
  historyId: string;
  toolId: string;
  runs: string[] | undefined;
  mapped: boolean;
  fileList: boolean;
}
export interface SraBlock {
  reason: string;
  call: SraCall;
  runs: string[];
  cause: "mapped-import" | "duplicate-accession" | "split-batch";
}
export function parseObject(value: unknown): Record<string, unknown> | null;
export function stable(value: unknown): string;
export function flatten(inputs: Record<string, unknown>): Record<string, unknown>;
export function accessions(value: unknown): string[] | undefined;
export function sraCall(
  name: unknown,
  input: unknown,
  options?: { normalizeName?: NormalizeName },
): SraCall | null;
export class SraImportGate {
  constructor(options: { remediation: (runs: string[]) => string; normalizeName?: NormalizeName });
  clear(): void;
  observe(calls: Iterable<{ id: string; name: string; arguments: unknown }>): void;
  block(id: string, name: string, args: unknown): SraBlock | undefined;
  check(id: string, name: string, args: unknown): string | undefined;
}
