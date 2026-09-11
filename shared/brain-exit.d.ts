/** sysexits.h EX_CONFIG -- the brain's "this is a config problem, retrying won't help". */
export const EX_CONFIG: number;

export function isConfigFailure(code: number | null | undefined): boolean;

/** Cap on the rolling stderr window a shell keeps, in characters. */
export const STDERR_BUFFER_LIMIT: number;

export function appendStderr(buffer: string, text: string, limit?: number): string;

export function stderrTail(
  stderr: string | null | undefined,
  opts?: { maxLines?: number; maxChars?: number },
): string;

/** A startup failure split by destination: `detail` for the chat pane, `summary` for the status pill. */
export function summarizeStartupFailure(
  code: number | null | undefined,
  stderr?: string,
): { summary: string; detail: string };
