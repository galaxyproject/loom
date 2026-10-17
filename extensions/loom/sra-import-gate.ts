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
import { parseObject, SraImportGate, type NormalizeName } from "../../shared/sra-import.js";
import { MCP_FAMILY, type GalaxyToolFamily } from "../../shared/galaxy-mcp-tools.js";
import { sraImportGuidance } from "../../shared/prompt-blocks.js";

export const SRA_IMPORT_GUIDANCE = `${sraImportGuidance()}
`;

// Galaxy's run_tool as the family names it, as a loom-native galaxy_ tool (any
// name the family doesn't claim), or wrapped in a generic `mcp({tool, args})`
// proxy. Names match exactly; unlike the browser's sra-gate normalizer this
// doesn't trim or lowercase.
function sraNormalizer(family: GalaxyToolFamily): NormalizeName {
  const strip = (name: string) => family.toolName(name) ?? name.replace(/^galaxy_/, "");
  return (name, args) => {
    if (name === "mcp") {
      if (args.server !== undefined && args.server !== "galaxy") return null;
      const inner = parseObject(args.args);
      return inner ? { name: strip(String(args.tool ?? "")), args: inner } : null;
    }
    return { name: strip(name), args };
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

export function registerSraImportGate(
  pi: ExtensionAPI,
  family: GalaxyToolFamily = MCP_FAMILY,
): void {
  const gate = new SraImportGate({ remediation, normalizeName: sraNormalizer(family) });
  const clear = () => gate.clear();
  pi.on("session_start", clear);
  pi.on("agent_end", clear);
  pi.on("input", clear);
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    gate.observe(event.message.content.flatMap((part) => (part.type === "toolCall" ? [part] : [])));
  });
  pi.on("tool_call", (event) => {
    const blocked = gate.block(event.toolCallId, event.toolName, event.input);
    if (!blocked) return;
    const notebook = getNotebookPath();
    if (notebook) {
      appendActivityEvent(path.dirname(notebook), {
        timestamp: new Date().toISOString(),
        kind: "sra.import.blocked",
        source: "sra-import-gate",
        payload: {
          toolCallId: event.toolCallId,
          historyId: blocked.call.historyId,
          toolId: blocked.call.toolId,
          accessions: blocked.runs,
          cause: blocked.cause,
        },
      });
    }
    return { block: true, reason: blocked.reason };
  });
}
