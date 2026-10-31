/**
 * Failed url-fetch triage hint.
 *
 * A dataset Galaxy failed to fetch says so in its `misc_info` ("Failed to fetch url <url>"). The
 * model's reflex is to retry with another url written from memory, which for ENA and SRA is always
 * wrong: their fastq paths are not derivable from an accession. This catches the failure in a tool
 * result and says what to do instead. A row in `skill-triggers.ts`; the browser shell's earlier
 * brain did the same.
 */

const FAILED_FETCH = /Failed to fetch url\s+(\S+)/;
/** ENA and SRA read paths, whose sharding is not derivable from an accession. */
const ARCHIVE_HOSTS = ["ftp.sra.ebi.ac.uk", "ftp.ncbi.nlm.nih.gov", "sra-pub", "sra-download"];
const ACCESSION = /\b[EDS]RR\d{6,}/;

export const ARCHIVE_FETCH_HINT =
  "[loom] A sequencing-archive fetch failed. Do not construct another url: ENA and SRA fastq " +
  "paths are not derivable from an accession, and whether a run is paired is a property " +
  "of the run rather than its name. Call `ena_runs` with the accession to read the exact " +
  "urls, checksums and layout.";

export const FETCH_FAILED_HINT =
  "[loom] A url fetch failed. Do not retry with another url written from memory; a url that was " +
  "not read from a tool result or given by the user is a guess. Establish the real " +
  "location first, or tell the user what you could not find.";

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Every dataset-shaped object in a result, however the tool nests them. */
function datasets(result: unknown): Row[] {
  if (Array.isArray(result)) return result.filter(isRow);
  if (!isRow(result)) return [];
  // Not `contents`: a history listing is Galaxy's summary view, which has no misc_info to read.
  const nested = ["outputs", "datasets"].flatMap((key) =>
    Array.isArray(result[key]) ? (result[key] as unknown[]).filter(isRow) : [],
  );
  return [result, ...nested];
}

/** The source url a dataset in this result failed to fetch, or undefined. */
export function failedUrl(result: unknown): string | undefined {
  for (const dataset of datasets(result)) {
    if (dataset.state !== "error") continue;
    const found = FAILED_FETCH.exec(String(dataset.misc_info || ""));
    if (found) return found[1];
  }
  return undefined;
}

/** The triage line a result earns, or null when nothing in it failed to fetch. */
export function fetchFailureHint(result: unknown): string | null {
  const url = failedUrl(result);
  if (url === undefined) return null;
  const archive = ARCHIVE_HOSTS.some((host) => url.includes(host)) || ACCESSION.test(url);
  return archive ? ARCHIVE_FETCH_HINT : FETCH_FAILED_HINT;
}

/** The hint for a tool result's text: the payload is the envelope's `data`, or the JSON itself. */
export function fetchFailureHintForText(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const data = isRow(parsed) && "data" in parsed ? parsed.data : parsed;
  return fetchFailureHint(data);
}
