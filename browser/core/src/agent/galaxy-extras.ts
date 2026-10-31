/**
 * The Galaxy tools the browser shell adds beside galaxy-ops' operations: the two that work on the
 * browser's in-memory filesystem (download_dataset, upload_file), and the image resolver that reads
 * quay.io's tag listing (recommend_biocontainer). Orbit registers them as Galaxy tools, so its
 * guards, capture and result hints see them like any other.
 */
import { quote } from "./quote";
import * as biocontainers from "./biocontainers";
import { segment, type Galaxy } from "./galaxy";
import * as tables from "./tables";
import { fail, type Capability, type Context, type AgentTool } from "./tool";

export const DATA_DIR = "/data";
/** Lines of a downloaded dataset shown in its result. */
export const PREVIEW_LINES = 50;
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

type Row = Record<string, any>;

const isRow = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);

const STR = { type: "string" };

/** Python's `str.splitlines`. */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A line-aligned prefix, or undefined if the datatype cannot be chunked. */
async function chunk(galaxy: Galaxy, datasetId: string, size: number): Promise<string | undefined> {
  try {
    const got = await galaxy.get(
      `api/datasets/${segment(datasetId)}/display?offset=0&ck_size=${segment(size)}`,
    );
    return isRow(got) ? (got.ck_data ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

async function downloadDataset(args: Row, { galaxy, python }: Context) {
  const details = (await galaxy.get(`api/datasets/${segment(args.dataset_id)}`)) || {};
  const state = isRow(details) ? details.state : undefined;
  if (state !== "ok") {
    return fail(
      `Dataset is in state ${quote(state)}, not "ok", so it holds nothing to read yet. ` +
        "Wait for the job producing it to finish and download it again.",
    );
  }
  const stated = details.file_size;
  let partial = false;
  let data: Uint8Array;
  if (Number.isInteger(stated) && stated > MAX_DOWNLOAD_BYTES) {
    // Only Galaxy's tabular datatypes serve a chunk of themselves; any other ignores the offset
    // and streams the whole file, and BAM answers with SAM text.
    const tabular = tables.isTable(details);
    const prefix = tabular ? await chunk(galaxy, args.dataset_id, MAX_DOWNLOAD_BYTES) : undefined;
    if (prefix === undefined) {
      return fail(
        `Dataset is ${(stated / 1e6).toFixed(1)} MB, over the ${MAX_DOWNLOAD_BYTES / 1e6} MB a ` +
          `download reads, and Galaxy cannot serve ${quote(details.extension)} data in parts. ` +
          "Run a Galaxy tool on it instead.",
      );
    }
    data = new TextEncoder().encode(prefix);
    partial = true;
  } else {
    data = await galaxy.bytes(`api/datasets/${segment(args.dataset_id)}/display`);
  }
  const path = `${DATA_DIR}/${args.dataset_id}.dat`;
  await python.write(path, data);

  const out: Row = { dataset_id: args.dataset_id, path, bytes: data.length };
  for (const [key, field] of [
    ["extension", "extension"],
    ["delimiter", "metadata_delimiter"],
  ]) {
    if (details[field] != null) {
      out[key] = details[field];
    }
  }
  if (partial) {
    Object.assign(out, { partial: true, bytes_total: stated });
  }
  const text = decodeUtf8(data);
  if (text === undefined) {
    return Object.assign(out, { binary: true, preview: null, lines: null, truncated: false });
  }
  const lines = splitLines(text);
  return Object.assign(out, {
    binary: false,
    lines: lines.length,
    preview: lines.slice(0, PREVIEW_LINES).join("\n"),
    truncated: lines.length > PREVIEW_LINES,
  });
}

/** A fetch payload placing one element into a history. */
function fetchPayload(element: Row, historyId: string | undefined) {
  const payload: Row = { targets: [{ destination: { type: "hdas" }, elements: [element] }] };
  if (historyId) {
    payload.history_id = historyId;
  }
  return payload;
}

async function uploadFile(args: Row, { galaxy, python }: Context) {
  const path: string = args.path;
  const raw = await python.read(path);
  if (raw === undefined) {
    return fail(`No such file: ${path}`);
  }
  const text = decodeUtf8(raw);
  if (text === undefined) {
    return fail(
      "Cannot upload binary content: Galaxy accepts pasted uploads as text only. " +
        "Use upload_file_from_url for binary data.",
    );
  }
  const element = {
    src: "pasted",
    paste_content: text,
    ext: args.file_type ?? "auto",
    dbkey: args.dbkey ?? "?",
    name: args.file_name || path.split("/").pop(),
  };
  return galaxy.post("api/tools/fetch", fetchPayload(element, args.history_id));
}

async function recommendBiocontainer(args: Row, ctx: Context) {
  try {
    return await biocontainers.recommend(args.packages || [], ctx.web.fetch);
  } catch (error) {
    return fail((error as Error).message);
  }
}

type Run = (args: Row, ctx: Context) => Promise<unknown>;

/**
 * What the agent says of the two tools that work on the browser's in-memory filesystem, which
 * galaxy-mcp's docstrings describe as the server's own disk, and of the image resolver, which
 * reads quay.io's tag listing rather than galaxy-mcp's mulled extra.
 */
const LOCAL_DOCS: Record<string, string> = {
  download_dataset:
    "Save a Galaxy dataset to the local filesystem.\n\nReturns `path`, `bytes`, `binary`, and for text data `lines`, a `preview` of the first 50 lines and `truncated`. Fetched as raw bytes, so BAM/HDF5/gzip arrive intact. The file lives in the browser's in-memory filesystem, which persists for the session, so read it with run_python -- text with `pandas.read_csv(path, sep='\\t')`, binary with `open(path, 'rb')` or a suitable library. Do not paste the preview into code: it is a sample, and re-emitting file content as a string breaks on tabs and newlines.",
  recommend_biocontainer:
    'Resolve a verified quay.io/biocontainers image for a conda package.\n\nUse this to pick the ``container`` of a user-defined tool instead of guessing an image, before the definition is written, as the udt-authoring skill says to do first. The result is read from quay.io\'s tag listing rather than hallucinated, which avoids the most common user-defined-tool failure: inventing a tag, or using a bare image (e.g. "python:3.12-slim") that doesn\'t ship the libraries the tool imports.\n\nArgs:\n    packages: The conda packages the tool wraps, each as "name" or "name=version" (e.g. ["samtools=1.17"]). Use canonical conda names you would `conda install` (e.g. "pandas", "r-ggplot2", "samtools"). A single package yields a single-package image. Several need a mulled-v2 image, which a tag listing cannot resolve: the result then holds no image and a note saying so.\n\nReturns:\n    - image: the resolved quay.io/biocontainers/... reference, or null if none.\n    - found: whether an image was resolved.\n    - match_quality: "exact_version" | "name_only" | "not_found" (name_only means no version was pinned, so the newest built tag was used; a pinned version with no built tag is not_found).\n    - source, notes: provenance and any explanatory notes.\n    - verified: true if the tag is built on quay.io, false if the pinned version is not, null if it could not be checked.\n\nNEXT STEPS:\n- If match_quality is "exact_version" and verified is not false, use data["image"] as the "container".\n- If match_quality is "name_only", show the user which image you got before using it.\n- If image is null, don\'t guess a tag: tell the user no built image was found for those packages and ask how to proceed.',
  upload_file:
    "Upload a file from the local filesystem to a Galaxy history.\n\nReads the path from the browser's in-memory filesystem, so it pairs with run_python: write a result to a file, then upload it. Sent to Galaxy as pasted content. Use upload_file_from_url to ingest directly from a URL instead.\n\nAn upload is a Galaxy job: the dataset comes back before it is readable. Wait for it to reach 'ok' (check its state with get_dataset_details) before running a tool on it or charting it.",
};

/** A tool the agent runs itself, under galaxy-mcp's name and its own description. */
function tool(
  name: string,
  capability: Capability,
  properties: Record<string, unknown>,
  required: string[],
  run: Run,
): AgentTool {
  return {
    name,
    description: LOCAL_DOCS[name],
    capability,
    parameters: { type: "object", properties, required },
    run,
  };
}

export function galaxyTools(): AgentTool[] {
  return [
    tool("download_dataset", "read", { dataset_id: STR }, ["dataset_id"], downloadDataset),
    tool(
      "upload_file",
      "write",
      { path: STR, history_id: STR, file_name: STR, file_type: STR, dbkey: STR },
      ["path"],
      uploadFile,
    ),
    tool(
      "recommend_biocontainer",
      "read",
      { packages: { type: "array", items: { type: "string" } } },
      ["packages"],
      recommendBiocontainer,
    ),
  ];
}
