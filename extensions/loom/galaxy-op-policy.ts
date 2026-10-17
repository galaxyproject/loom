/**
 * What the brain layers on a galaxy-ops operation it does not own: policy, never behaviour.
 *
 * An operation does what Galaxy does; a policy decides whether this call should go out at all
 * (`check`), what it waits behind or rewrites on the way (`around`), and what the model is told
 * when Galaxy refuses it (`refused`). Keeping the two apart is what lets a bridging op be deleted
 * when galaxy-ops ships the same operation without the brain losing what it adds.
 *
 * Policies see the tool's arguments as the model sent them: snake_case, after pi's validation.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { malformedObjectIds } from "../../shared/malformed-object-ids.js";
import { sectionsHeaded } from "../../shared/markdown-sections.js";
import { pageContentHash } from "../../shared/page-content-hash.js";
import { ELISION_MARKER } from "../../shared/record-excerpt.js";
import { galaxyGet } from "./galaxy-api";
import { malformedIdsRefusal, pageBody } from "./galaxy-page-ops";
import { installedRecordStore, withRecordLock } from "./record-store-seam";

export type GalaxyOpArgs = Record<string, unknown>;

export interface GalaxyOpPolicy {
  /** The brain's refusal before the operation runs, or undefined to let it run. */
  check?(args: GalaxyOpArgs, call: { signal: AbortSignal }): Promise<string | undefined>;
  /** Runs the call; `call` sends `args`, or the arguments it is given in their place. */
  around?<T>(
    call: (sent?: GalaxyOpArgs) => Promise<T>,
    args: GalaxyOpArgs,
    ctx: { signal: AbortSignal },
  ): Promise<T>;
  /** A replacement for Galaxy's refusal message, when the policy has something to add. */
  refused?(message: string, args: GalaxyOpArgs): string | undefined;
}

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);

// A lookup the deadline cut short is not a lookup that failed: failing open there would let the
// call run after the model was told its result is unknown.
function rethrowIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

/**
 * `work`, given up on once `signal` aborts. The deadline only stops waiting for a call; a
 * transport that ignores its signal leaves the call itself pending, and a lock held across it
 * would never be released.
 */
function untilAborted<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abandon = () => reject(signal.reason);
    signal.addEventListener("abort", abandon, { once: true });
    work().then(
      (value) => {
        signal.removeEventListener("abort", abandon);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abandon);
        reject(error);
      },
    );
  });
}

// ── run_tool: input keys Galaxy would not read ───────────────────────────────────────────────────

/**
 * Whether Galaxy's legacy tool state reads `key` for these declared inputs: a parameter by its
 * name, a repeat's instance as `name_N|`, a conditional or section member as `name|`, the way
 * Galaxy's `_populate_state_legacy` builds its keys.
 */
function reads(declared: unknown, key: string): boolean {
  return (Array.isArray(declared) ? declared : []).filter(isRow).some((p) => {
    const name = String(p.name ?? "");
    if (!name) return false;
    if (p.type === "repeat" || p.type === "upload_dataset") {
      const instance = key.match(/^(.+?)_\d+\|(.+)$/);
      return instance?.[1] === name && reads(p.inputs, instance[2]);
    }
    if (p.type === "conditional") {
      const test = isRow(p.test_param) ? p.test_param.name : undefined;
      if (key === test) return true;
      const rest = key.startsWith(`${name}|`) ? key.slice(name.length + 1) : undefined;
      return (
        rest !== undefined &&
        (rest === test ||
          (Array.isArray(p.cases) ? p.cases : []).some((c) => isRow(c) && reads(c.inputs, rest)))
      );
    }
    if (p.type === "section") {
      return key.startsWith(`${name}|`) && reads(p.inputs, key.slice(name.length + 1));
    }
    return key === name;
  });
}

/** The keys Galaxy reads for these declared inputs, a repeat shown by its first instance. */
function keysOf(declared: unknown, prefix = ""): string[] {
  return (Array.isArray(declared) ? declared : []).filter(isRow).flatMap((p) => {
    const key = `${prefix}${String(p.name)}`;
    if (p.type === "repeat" || p.type === "upload_dataset") return keysOf(p.inputs, `${key}_0|`);
    if (p.type === "conditional") {
      const test = isRow(p.test_param) ? String(p.test_param.name) : "";
      const cases = (Array.isArray(p.cases) ? p.cases : [])
        .filter(isRow)
        .flatMap((c) => keysOf(c.inputs, `${key}|`));
      return [`${key}|${test}`, ...new Set(cases)];
    }
    return p.type === "section" ? keysOf(p.inputs, `${key}|`) : [key];
  });
}

/**
 * A refusal for run_tool input keys the tool does not declare. Galaxy drops a key it does not
 * read without a word and runs the tool on its defaults, so a misspelt parameter becomes a job
 * that answers a different question. Anything this cannot establish -- a failed lookup, a schema
 * for another tool or version, a tool with no declared inputs -- is left for Galaxy to decide.
 */
export async function unreadInputs(
  args: GalaxyOpArgs,
  { signal }: { signal: AbortSignal },
): Promise<string | undefined> {
  const { tool_id: toolId, tool_version: version, inputs } = args;
  if (!isRow(inputs) || typeof toolId !== "string" || !toolId) return undefined;
  const pinned = typeof version === "string" && version ? version : undefined;
  let schema: unknown;
  try {
    schema = await galaxyGet(
      `/tools/${encodeURIComponent(toolId)}?io_details=true${pinned ? `&tool_version=${encodeURIComponent(pinned)}` : ""}`,
      signal,
    );
  } catch {
    rethrowIfAborted(signal);
    return undefined;
  }
  if (!isRow(schema) || !Array.isArray(schema.inputs) || schema.inputs.length === 0) {
    return undefined;
  }
  // Galaxy expands a short id and serves its newest version when the one asked for is missing;
  // a schema for another tool or version says nothing about this call.
  const id = String(schema.id ?? "");
  if (!(id === toolId || id.startsWith(`${toolId}/`))) return undefined;
  if (pinned && schema.version !== pinned) return undefined;
  const unread = Object.keys(inputs).filter(
    (key) =>
      !key.startsWith("__") && !key.endsWith("|__identifier__") && !reads(schema.inputs, key),
  );
  if (unread.length === 0) return undefined;
  const list = (keys: string[]) => keys.map((k) => JSON.stringify(k)).join(", ");
  return (
    `Refused: ${toolId} has no input at ${list(unread)}, so Galaxy would drop ` +
    `${unread.length > 1 ? "them" : "it"} and run the tool without saying so. The keys it ` +
    `reads are ${list(keysOf(schema.inputs))}. A repeat takes one key prefix per instance ` +
    `(\`name_0|\`, \`name_1|\`), a conditional or section member is \`name|member\`, and a ` +
    `parameter that takes several datasets takes them under its own key as {"values": [...]}.`
  );
}

// ── pages: what the model was shown, and section edits against the page as it is now ────────────

/**
 * Page bodies this session's model was shown, keyed by page and the content_hash it saw with
 * them. Enough to tell whether a section the model is rewriting moved since it read the page.
 */
const shown = new Map<string, string>();
const SHOWN_KEPT = 20;
const shownKey = (pageId: string, hash: string) => JSON.stringify([pageId, hash]);

function remember(pageId: string, body: string, claimed: unknown): void {
  const hash = pageContentHash(body);
  // A body that does not hash to what the model was told is not what it saw.
  if (typeof claimed === "string" && claimed !== hash) return;
  const key = shownKey(pageId, hash);
  shown.delete(key);
  shown.set(key, body);
  if (shown.size > SHOWN_KEPT) shown.delete(shown.keys().next().value!);
}

/** Forget every page body; a new session's model has been shown none. */
export function resetShownPages(): void {
  shown.clear();
}

/** Keep the page a successful call answered with as what the model was shown. */
function shownPage<T>(env: T, args: GalaxyOpArgs): T {
  const { success, data } = (env ?? {}) as { success?: unknown; data?: unknown };
  if (
    success === true &&
    isRow(data) &&
    typeof args.page_id === "string" &&
    (data.content_editor != null || data.content != null)
  ) {
    remember(args.page_id, pageBody(data as Parameters<typeof pageBody>[0]), data.content_hash);
  }
  return env;
}

/**
 * A section edit's arguments against the page as it is now. Orbit writes into the record page
 * itself (the poller's job blocks, the session's own lines), so a hash the model read before one
 * of those writes no longer matches. When the model's read is known and the sections it replaces
 * are unchanged since, the edit is just as right against the current page, and is sent with the
 * current hash. Anything else goes as given, and the bridge refuses a stale hash. A hash the
 * model did not send is never supplied.
 */
async function againstCurrent(args: GalaxyOpArgs, signal: AbortSignal): Promise<GalaxyOpArgs> {
  const { expect_hash: read, section_heading: heading, page_id: pageId } = args;
  if (typeof read !== "string" || typeof heading !== "string" || typeof pageId !== "string") {
    return args;
  }
  if (args.content != null) return args;
  const base = shown.get(shownKey(pageId, read));
  if (base === undefined) return args;
  let current: string;
  try {
    const page = await galaxyGet<Parameters<typeof pageBody>[0] | null>(
      `/pages/${encodeURIComponent(pageId)}`,
      signal,
    );
    current = pageBody(page ?? {});
  } catch {
    rethrowIfAborted(signal);
    return args;
  }
  const now = pageContentHash(current);
  if (now === read) return args;
  const same =
    JSON.stringify(sectionsHeaded(base, heading)) ===
    JSON.stringify(sectionsHeaded(current, heading));
  return same ? { ...args, expect_hash: now } : args;
}

const HEADING_LINE = /^#{1,6}\s+\S/;

/** A refusal for a section edit that would leave its text without a heading on the page. */
function headingless(args: GalaxyOpArgs): string | undefined {
  if (args.section_heading == null) return undefined;
  const heading = String(args.section_heading);
  // No heading line on a page holds a newline, so such a heading never matches and the edit
  // would land at the end of the page.
  if (heading.includes("\n")) {
    return (
      `Refused: section_heading is one line, the heading line exactly as the page writes it ` +
      `(such as "## Results"). Everything under it goes in section_content.`
    );
  }
  if (!HEADING_LINE.test(heading)) {
    return (
      `Refused: section_heading is the heading line itself, exactly as the page writes it ` +
      `(such as ${JSON.stringify(`## ${heading.trim()}`)}), not the bare title. A line the page ` +
      `does not hold as a heading adds the text at the end of the page under no heading.`
    );
  }
  // Leaves the pair refusal to the bridge, which says what is missing.
  if (args.section_content == null) return undefined;
  // Only blank lines are skipped: an indented heading line is not a heading to markdown, so the
  // section would merge into the one above it.
  const first = String(args.section_content)
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .split("\n")[0];
  if (HEADING_LINE.test(first)) return undefined;
  return (
    `Refused: section_content replaces the whole section, its heading line included, so it ` +
    `starts with ${JSON.stringify(heading)}. Without that line the page loses the heading.`
  );
}

/**
 * Keyed by operation name. These are the brain's own checks; Galaxy's server validation stays
 * the backstop for anything they do not cover.
 */
export const GALAXY_OP_POLICY: Record<string, GalaxyOpPolicy> = {
  run_tool: { check: unreadInputs },
  create_page: {
    check: async (args) => {
      const found = malformedObjectIds(typeof args.content === "string" ? args.content : null);
      return found.length > 0 ? malformedIdsRefusal(found) : undefined;
    },
  },
  get_page: {
    around: async (call, args) => shownPage(await call(), args),
  },
  update_page: {
    check: async (args) => {
      // Orbit shows the model a head-and-tail excerpt of the record; content copied from it
      // would replace the middle of the page with the marker.
      if (typeof args.content === "string" && args.content.includes(ELISION_MARKER)) {
        return (
          `Refused: this content still holds the record excerpt's elision marker ` +
          `(${ELISION_MARKER}), so writing it would delete the part of the page the excerpt ` +
          `left out. Rewrite the section you mean with section_heading and section_content instead.`
        );
      }
      // The excerpt cuts by length, so one section can straddle the cut.
      if (
        typeof args.section_content === "string" &&
        args.section_content.includes(ELISION_MARKER)
      ) {
        return (
          `Refused: this section_content still holds the record excerpt's elision marker ` +
          `(${ELISION_MARKER}), so writing it would delete the part of the section the excerpt ` +
          `left out. Read the page with get_page and rewrite the section from what it holds.`
        );
      }
      return headingless(args);
    },
    around: async (call, args, { signal }) => {
      const run = async () => {
        const sent = await againstCurrent(args, signal);
        return shownPage(await call(sent === args ? undefined : sent), args);
      };
      // The bridge reads the page and then writes it. On the record page the poller writes
      // under this lock, so holding it closes that window; a file record has no page id. The
      // lock ends with the deadline, not with a request that may never come back.
      const store = installedRecordStore();
      return store?.kind === "page" && store.pageId !== undefined && store.pageId === args.page_id
        ? withRecordLock(store.key, () => untilAborted(signal, run))
        : run();
    },
  },
};

/** The policy's session state: a new session forgets the pages the last one was shown. */
export function registerGalaxyOpPolicy(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    resetShownPages();
  });
}
