// Shared, shell-neutral core of the SRA fan-out gate. Orbit's brain and the browser agent both
// refuse one fastq_dump/fasterq_dump job per accession; the parsing and the turn-local batch
// bookkeeping live here, while each shell keeps its own tool-name family and refusal wording.

const SRA_TOOL = /^(?:(?:[^/]+\/repos\/iuc\/sra_tools\/)?(?:fastq_dump|fasterq_dump))(?:\/[^/]+)?$/;
const ACCESSION = /^(?:SRR|ERR|DRR)\d+$/;

/** @typedef {Record<string, unknown>} Obj */

/** @param {unknown} value @returns {Obj | null} */
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Obj} */ (value)
    : null;
}

/** A JSON object, given as one or as its JSON text.
 * @param {unknown} value @returns {Obj | null} */
export function parseObject(value) {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}

/** A canonical rendering, so two spellings of the same settings share a key.
 * @param {unknown} value @returns {string} */
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const obj = object(value);
  if (obj)
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** @param {Obj} inputs @returns {Obj} */
export function flatten(inputs) {
  /** @type {Obj} */
  const result = {};
  for (const [key, value] of Object.entries(inputs)) {
    const group = key === "input" || key === "adv" ? object(value) : null;
    if (!group) {
      result[key] = value;
      continue;
    }
    for (const [child, v] of Object.entries(group)) {
      if (child !== "__current_case__") result[`${key}|${child}`] = v;
    }
  }
  return result;
}

/** @param {unknown} value @returns {string[] | undefined} */
export function accessions(value) {
  if (typeof value !== "string") return undefined;
  const runs = value
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean);
  return runs.length > 0 && runs.every((r) => ACCESSION.test(r)) ? runs : undefined;
}

/** @type {import("./sra-import.js").NormalizeName} */
const identity = (name, args) => ({ name, args });

/**
 * Exact structured surfaces only; never interpret arbitrary Python as JSON.
 * @param {unknown} name
 * @param {unknown} input
 * @param {{ normalizeName?: import("./sra-import.js").NormalizeName }} [options]
 * @returns {import("./sra-import.js").SraCall | null}
 */
export function sraCall(name, input, { normalizeName = identity } = {}) {
  const parsed = parseObject(input);
  if (!parsed) return null;
  const normalized = normalizeName(String(name ?? ""), parsed);
  if (!normalized || normalized.name !== "run_tool") return null;
  const args = normalized.args;
  const toolId = args.tool_id;
  const historyId = args.history_id;
  if (typeof toolId !== "string" || typeof historyId !== "string" || !historyId) return null;
  if (!SRA_TOOL.test(toolId)) return null;
  const inputs = parseObject(args.inputs);
  if (!inputs) return null;
  const flat = flatten(inputs);
  const mode = flat["input|input_select"] ?? "accession_number";
  if (mode !== "accession_number" && mode !== "file_list") return null;
  const value = flat[mode === "file_list" ? "input|file_list" : "input|accession"];
  const ref = object(value);
  const settings = { ...flat };
  delete settings["input|input_select"];
  delete settings["input|accession"];
  delete settings["input|file_list"];
  return {
    key: stable({ ...args, inputs: settings }),
    historyId,
    toolId,
    runs: mode === "accession_number" ? accessions(value) : undefined,
    mapped: ref?.__class__ === "Batch" || ref?.batch === true || ref?.src === "hdca",
    fileList: mode === "file_list" && ref?.src === "hda" && typeof ref.id === "string",
  };
}

/** Turn-local import intent: what was fanned out, what was let through, what landed. */
export class SraImportGate {
  /** @param {{ remediation: (runs: string[]) => string, normalizeName?: import("./sra-import.js").NormalizeName }} options */
  constructor({ remediation, normalizeName }) {
    this.remediation = remediation;
    this.options = { normalizeName };
    // Not a second durable import registry. A rejected batch is kept across tool-error
    // recovery so serializing the same calls won't pass.
    /** @type {Map<string, Set<string>>} */
    this.batches = new Map();
    /** @type {Set<string>} */
    this.blocked = new Set();
    // A history preflight can leave exactly one missing accession, and a literal singleton is
    // the right call for it. Let one singleton out of a rejected batch per key; a second one is
    // serialization.
    /** @type {Set<string>} */
    this.releasedSingleton = new Set();
    // Accessions already sent to Galaxy in one combined call this turn. Splitting them
    // afterwards is failure recovery (bad accession, resource limit), not fan-out.
    /** @type {Map<string, Set<string>>} */
    this.submitted = new Map();
  }

  clear() {
    this.batches.clear();
    this.blocked.clear();
    this.releasedSingleton.clear();
    this.submitted.clear();
  }

  /** One completed answer's calls, read together before any of them runs.
   * @param {Iterable<{ id: string, name: string, arguments: unknown }>} calls */
  observe(calls) {
    /** @type {Map<string, Array<{ id: string, run: string }>>} */
    const groups = new Map();
    for (const part of calls) {
      const call = sraCall(part.name, part.arguments, this.options);
      if (!call || call.runs?.length !== 1 || call.mapped) continue;
      if (this.submitted.get(call.key)?.has(call.runs[0])) continue;
      const group = groups.get(call.key) ?? [];
      group.push({ id: part.id, run: call.runs[0] });
      groups.set(call.key, group);
    }
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const batch = this.batches.get(key) ?? new Set();
      for (const { id, run } of group) {
        batch.add(run);
        this.blocked.add(id);
      }
      this.batches.set(key, batch);
    }
  }

  /**
   * @param {string} id @param {string} name @param {unknown} args
   * @returns {import("./sra-import.js").SraBlock | undefined}
   */
  block(id, name, args) {
    const call = sraCall(name, args, this.options);
    if (!call) return undefined;
    const batch = this.batches.get(call.key);
    const runs = call.runs ?? [];
    const duplicate = new Set(runs).size < runs.length;
    const single = runs.length === 1 ? runs[0] : undefined;
    let serialized = !!(batch && single && batch.size > 1 && batch.has(single));
    const blocked = this.blocked.has(id) || call.mapped || duplicate;
    if (serialized && !blocked && !this.releasedSingleton.has(call.key)) {
      this.releasedSingleton.add(call.key);
      serialized = false;
    }
    if (!blocked && !serialized) {
      // A history preflight may reduce the candidate set. Do not force the original candidates
      // back into a corrected batch and re-download them.
      if (batch && single) batch.delete(single);
      if (batch && (call.fileList || runs.length > 1)) this.batches.delete(call.key);
      if (runs.length > 1) {
        const sent = this.submitted.get(call.key) ?? new Set();
        for (const run of runs) sent.add(run);
        this.submitted.set(call.key, sent);
      }
      return undefined;
    }
    const candidates = [...new Set([...(batch ?? []), ...runs])];
    return {
      reason: this.remediation(candidates),
      call,
      runs: candidates,
      cause: call.mapped ? "mapped-import" : duplicate ? "duplicate-accession" : "split-batch",
    };
  }

  /** The refusal for a call about to run, or undefined to let it through.
   * @param {string} id @param {string} name @param {unknown} args @returns {string | undefined} */
  check(id, name, args) {
    return this.block(id, name, args)?.reason;
  }
}
