/**
 * `ena_runs`: the real FASTQ download URLs for an ENA or SRA accession. Ported from the browser
 * agent (browser/core/src/agent/ena.ts) so both shells answer it the same way; plain HTTPS to
 * ENA's portal API, no Galaxy involved. Registered in tools.ts, which keeps this file free of pi-tui.
 *
 * Interim: an accession lookup isn't Orbit's to own. It belongs in galaxy-ops, or in BRC-analytics'
 * hosted MCP server so it's just a service Orbit uses, and this file goes once it lives in either.
 */
export const ENA_HOST = "www.ebi.ac.uk";
export const FIELDS =
  "run_accession,library_layout,fastq_ftp,fastq_md5,fastq_bytes,read_count,scientific_name";
export const RUNS_DEFAULT = 25;
export const RUNS_MAX = 500;
/** The model reads every error it is handed, so an HTML error page shouldn't arrive whole. */
export const ERROR_MAX = 1000;

/** Percent-encode everything but unreserved characters. */
const quote = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** ENA lists paths without a scheme, semicolon-separated; https serves all of them. */
const urls = (field?: string) =>
  (field || "")
    .split(";")
    .filter(Boolean)
    .map((p) => `https://${p}`);

/** The TSV ENA answers with, as records; an empty body means no runs matched. */
function rows(table: string): Record<string, string>[] {
  const lines = table.trim().split(/\r\n|\r|\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(header.slice(0, cells.length).map((name, i) => [name, cells[i]]));
  });
}

/**
 * A paired run's mates, when ENA's file names say which is which: exactly one `<run>_1.` and one
 * `<run>_2.`. Never guessed from the order or the number of files.
 */
function mates(run: string | undefined, files: string[]) {
  const named = (mate: number) =>
    files.filter((url) => url.split("/").pop()?.startsWith(`${run}_${mate}.`));
  const [first, second] = [named(1), named(2)];
  if (!run || first.length !== 1 || second.length !== 1) {
    return {
      note: "ENA's file names do not say which file is which mate; check before pairing them.",
    };
  }
  const unpaired = files.filter((url) => url !== first[0] && url !== second[0]);
  return { mate1: first[0], mate2: second[0], ...(unpaired.length ? { unpaired } : {}) };
}

function clampLimit(limit: unknown): number {
  const value = limit || RUNS_DEFAULT;
  const n =
    typeof value === "number"
      ? Math.trunc(value)
      : /^\s*[+-]?\d+\s*$/.test(String(value))
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? Math.max(1, Math.min(n, RUNS_MAX)) : RUNS_DEFAULT;
}

function briefly(text: string): string {
  const said = text.replace(/\s+/g, " ").trim();
  return said.length > ERROR_MAX
    ? `${said.slice(0, ERROR_MAX)}… (${said.length - ERROR_MAX} more characters)`
    : said;
}

export interface EnaAnswer {
  text: string;
  isError: boolean;
  count?: number;
}

export async function enaRuns(
  args: { accession?: string; limit?: unknown },
  signal?: AbortSignal,
): Promise<EnaAnswer> {
  const accession = (args?.accession || "").trim();
  if (!accession) {
    return {
      text: JSON.stringify({ error: "An ENA or SRA accession is required." }),
      isError: true,
    };
  }
  const limit = clampLimit(args?.limit);

  let table: string;
  try {
    const response = await fetch(
      `https://${ENA_HOST}/ena/portal/api/filereport?accession=${quote(accession)}` +
        `&result=read_run&fields=${FIELDS}&format=tsv&limit=${limit + 1}`,
      { signal },
    );
    table = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${briefly(table)}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { text: JSON.stringify({ accession, error: detail }), isError: true };
  }

  const found = rows(table);
  if (!found.length) {
    return {
      text: JSON.stringify({
        accession,
        count: 0,
        runs: [],
        hint: "ENA holds no sequencing runs under this accession.",
      }),
      isError: false,
      count: 0,
    };
  }

  const truncated = found.length > limit;
  const runs = found.slice(0, limit).map((row) => {
    const files = urls(row.fastq_ftp);
    const paired = row.library_layout === "PAIRED";
    return {
      run: row.run_accession ?? null,
      layout: row.library_layout ?? null,
      paired,
      urls: files,
      ...(paired ? mates(row.run_accession, files) : {}),
      md5: (row.fastq_md5 || "").split(";").filter(Boolean),
      bytes: (row.fastq_bytes || "")
        .split(";")
        .filter((b) => /^\d+$/.test(b))
        .map(Number),
      read_count: row.read_count ?? null,
      organism: row.scientific_name ?? null,
    };
  });

  return {
    text: JSON.stringify({
      accession,
      count: runs.length,
      runs,
      ...(truncated
        ? { truncated: true, note: `Showing ${limit} runs; raise \`limit\` for more.` }
        : {}),
      hint:
        "The urls are exact and are for the cases that need a direct fetch; " +
        "never edit or construct one.",
    }),
    isError: false,
    count: runs.length,
  };
}
