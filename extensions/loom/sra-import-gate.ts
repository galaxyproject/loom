/**
 * Catch wasteful SRA fan-out before Galaxy receives any submissions.
 *
 * A completed assistant message contains all sibling calls before tool_call
 * runs. Group only known SRA download wrappers with identical destination and
 * settings. Return an actionable tool error, not a UI approval question.
 * Essential guidance also lives in the system prompt: opaque Python/bash and
 * accessions introduced one at a time cannot be inferred from sibling calls.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { appendActivityEvent } from "./activity";
import { getNotebookPath } from "./state";

export const SRA_IMPORT_GUIDANCE = `### Importing SRA/ENA sequencing runs

Before submitting, gather the full set of run accessions requested for this
analysis and deduplicate it. Inspect the destination history and notebook:
reuse verified inputs and wait for matching imports already running; retry
only missing or demonstrably failed runs. Do not expand to unrelated runs in
a study or replace verified data unless the user requested that scope.

For Galaxy fastq_dump/fasterq_dump, inspect the installed input template and
submit compatible accessions in ONE tool call. The IUC wrappers accept a
comma-separated string in input|accession with input|input_select=accession_number,
or one uploaded text dataset (one accession per line) in input|file_list with
input|input_select=file_list. A list file is a single HDA, not a mapped HDCA.
Do not loop over accessions or use Galaxy's batch/map mechanism: that creates
separate jobs and collections. Do not download FASTQs locally and re-upload.
For paired-end data use the wrapper's paired output (normally list_paired,
list:paired); keep singleton/other outputs available for verification. Do not
create per-run collections and merge them when the importer can build one.
Preserve requested extraction settings and compression; splitting into
separate jobs is justified only by different settings or a demonstrated
server/resource limit, not by the number of samples alone.

Loom records the import job itself; bind it to its plan step with
galaxy_job_record and note the returned collection ID in the notebook. Before using the
collection, verify population state, expected accession count and identifiers,
forward/reverse members, dataset states and appropriate content checks. A job
reported ok can still have failed or missing outputs. For ENA URL imports,
prefer a single server-side fetch into a named list:paired collection with
checksums when supported, rather than one upload per mate. Never delete prior
outputs merely to hide clutter; reuse them and preserve provenance.
`;

type Obj = Record<string, unknown>;
function object(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : null;
}
function parseObject(value: unknown): Obj | null {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const obj = object(value);
  if (obj)
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function flatten(inputs: Obj): Obj {
  const result: Obj = {};
  for (const [key, value] of Object.entries(inputs)) {
    if ((key === "input" || key === "adv") && object(value)) {
      for (const [child, v] of Object.entries(value as Obj)) {
        if (child !== "__current_case__") result[`${key}|${child}`] = v;
      }
    } else result[key] = value;
  }
  return result;
}
function accessions(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  const runs = value
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean);
  return runs.length > 0 && runs.every((r) => /^(SRR|ERR|DRR)\d+$/.test(r)) ? runs : null;
}

interface SraCall {
  key: string;
  historyId: string;
  toolId: string;
  runs: string[] | null;
  mapped: boolean;
  fileList: boolean;
}

/** Exact structured surfaces only; never interpret arbitrary Python as JSON. */
function sraCall(name: string, input: unknown): SraCall | null {
  let args = parseObject(input);
  if (!args) return null;
  if (name === "mcp") {
    if (args.server !== undefined && args.server !== "galaxy") return null;
    name = String(args.tool ?? "");
    args = parseObject(args.args);
    if (!args) return null;
  }
  if (!/^(?:galaxy_|mcp__galaxy__)?run_tool$/.test(name)) return null;
  const toolId = args.tool_id;
  const historyId = args.history_id;
  if (typeof toolId !== "string" || typeof historyId !== "string" || !historyId) return null;
  if (
    !/^(?:(?:[^/]+\/repos\/iuc\/sra_tools\/)?(?:fastq_dump|fasterq_dump))(?:\/[^/]+)?$/.test(toolId)
  )
    return null;
  const inputs = parseObject(args.inputs);
  if (!inputs) return null;
  const flat = flatten(inputs);
  const mode = flat["input|input_select"] ?? "accession_number";
  if (mode !== "accession_number" && mode !== "file_list") return null;
  const value = flat[mode === "file_list" ? "input|file_list" : "input|accession"];
  const ref = object(value);
  const mapped = ref?.__class__ === "Batch" || ref?.batch === true || ref?.src === "hdca";
  const fileList = mode === "file_list" && ref?.src === "hda" && typeof ref.id === "string";
  const settings = { ...flat };
  delete settings["input|input_select"];
  delete settings["input|accession"];
  delete settings["input|file_list"];
  return {
    key: stable({ ...args, inputs: settings }),
    historyId,
    toolId,
    runs: mode === "accession_number" ? accessions(value) : null,
    mapped,
    fileList,
  };
}

function remediation(runs: string[]): string {
  const unique = [...new Set(runs)];
  return (
    "[loom] Batch SRA imports before submission. No job was submitted by this blocked call. " +
    "Use one fastq_dump/fasterq_dump call for all requested, missing accessions with identical settings, " +
    "not one job per accession or a mapped collection. " +
    (unique.length
      ? `Candidate accessions from the blocked calls: ${JSON.stringify(unique.join(","))}. `
      : "") +
    "Exclude verified or running imports first. For the remaining accessions, use a comma-separated " +
    "input|accession string with input|input_select=accession_number, or " +
    'one text HDA (one accession per line) with input|input_select=file_list and input|file_list={src:"hda",id:<real dataset ID>}. ' +
    "Inspect the installed tool template; retain the extraction settings and use its list:paired output for paired reads. " +
    "Check the history/notebook first so verified or running imports are not repeated. " +
    "Correct the call yourself; do not ask the user to authorize batching or retry the same single-accession calls."
  );
}

export function registerSraImportGate(pi: ExtensionAPI): void {
  // Turn-local intent, not a second durable import registry. Keep a rejected
  // batch across tool-error recovery so serializing the same calls won't pass.
  const batches = new Map<string, Set<string>>();
  const blockedCalls = new Set<string>();
  // A history preflight can leave exactly one missing accession, and a literal
  // singleton is the right call for it. Let one singleton out of a rejected
  // batch per key; a second one is serialization.
  const releasedSingleton = new Set<string>();
  // Accessions already sent to Galaxy in one combined call this turn. Splitting
  // them afterwards is failure recovery (bad accession, resource limit), not
  // fan-out.
  const submitted = new Map<string, Set<string>>();
  const clear = () => {
    batches.clear();
    blockedCalls.clear();
    releasedSingleton.clear();
    submitted.clear();
  };
  pi.on("session_start", clear);
  pi.on("agent_end", clear);
  pi.on("input", clear);
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const groups = new Map<string, { id: string; run: string }[]>();
    for (const part of event.message.content) {
      if (part.type !== "toolCall") continue;
      const call = sraCall(part.name, part.arguments);
      if (!call || call.runs?.length !== 1 || call.mapped) continue;
      if (submitted.get(call.key)?.has(call.runs[0])) continue;
      const calls = groups.get(call.key) ?? [];
      calls.push({ id: part.id, run: call.runs[0] });
      groups.set(call.key, calls);
    }
    for (const [key, calls] of groups) {
      if (calls.length < 2) continue;
      const batch = batches.get(key) ?? new Set<string>();
      for (const call of calls) {
        batch.add(call.run);
        blockedCalls.add(call.id);
      }
      batches.set(key, batch);
    }
  });
  pi.on("tool_call", (event) => {
    const call = sraCall(event.toolName, event.input);
    if (!call) return;
    const batch = batches.get(call.key);
    const duplicate = call.runs && new Set(call.runs).size < call.runs.length;
    const single = call.runs?.length === 1 ? call.runs[0] : null;
    let serializedRetry = !!(batch && single && batch.size > 1 && batch.has(single));
    const otherwiseBlocked = blockedCalls.has(event.toolCallId) || call.mapped || duplicate;
    if (serializedRetry && !otherwiseBlocked && !releasedSingleton.has(call.key)) {
      releasedSingleton.add(call.key);
      serializedRetry = false;
    }
    if (!otherwiseBlocked && !serializedRetry) {
      // A history preflight may reduce the candidate set. Do not force the
      // original candidates back into a corrected batch and re-download them.
      if (batch && single) batch.delete(single);
      if (batch && (call.fileList || (call.runs && call.runs.length > 1))) {
        batches.delete(call.key);
      }
      if (call.runs && call.runs.length > 1) {
        const sent = submitted.get(call.key) ?? new Set<string>();
        for (const run of call.runs) sent.add(run);
        submitted.set(call.key, sent);
      }
      return;
    }
    const runs = [...new Set([...(batch ?? []), ...(call.runs ?? [])])];
    const reason = remediation(runs);
    const notebook = getNotebookPath();
    if (notebook) {
      appendActivityEvent(path.dirname(notebook), {
        timestamp: new Date().toISOString(),
        kind: "sra.import.blocked",
        source: "sra-import-gate",
        payload: {
          toolCallId: event.toolCallId,
          historyId: call.historyId,
          toolId: call.toolId,
          accessions: runs,
          cause: call.mapped ? "mapped-import" : duplicate ? "duplicate-accession" : "split-batch",
        },
      });
    }
    return { block: true, reason };
  });
}
