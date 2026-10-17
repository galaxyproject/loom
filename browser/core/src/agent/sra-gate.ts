import { SraImportGate as Gate, type NormalizeName } from "../../../../shared/sra-import.js";

// The browser's tools carry Galaxy's bare names, so only the spelling is loosened.
const normalizeName: NormalizeName = (name, args) => ({ name: name.trim().toLowerCase(), args });

export function remediation(runs: string[]): string {
  const unique = [...new Set(runs)];
  const candidates = unique.length
    ? `Candidate accessions from the blocked calls: ${JSON.stringify(unique.join(","))}. `
    : "";
  return (
    "Refused: batch SRA imports before submission. No job was submitted by this blocked call. " +
    "Use one fastq_dump/fasterq_dump call for all requested, missing accessions with identical " +
    "settings, not one job per accession or a mapped collection. " +
    candidates +
    "Exclude verified or running imports first. For the remaining accessions, use a " +
    "comma-separated input|accession string with input|input_select=accession_number, or one " +
    "text HDA (one accession per line) with input|input_select=file_list and " +
    'input|file_list={src:"hda",id:<real dataset ID>}. ' +
    "Inspect the installed tool template; retain the extraction settings and use its " +
    "list:paired output for paired reads. Check the history and notebook first so verified or " +
    "running imports are not repeated. Correct the call yourself; do not ask the user to " +
    "authorize batching or retry the same single-accession calls."
  );
}

/** Turn-local import intent: what was fanned out, what was let through, what landed. */
export class SraImportGate extends Gate {
  constructor() {
    super({ remediation, normalizeName });
  }
}
