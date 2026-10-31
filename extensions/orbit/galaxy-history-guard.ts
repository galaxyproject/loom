/**
 * Refuse a Galaxy tool run whose inputs live in a history other than the one
 * the job runs in. Galaxy allows it, but an agent that does it has nearly
 * always copied the wrong id, and the job answers a question nobody asked.
 * Ported from the browser shell's run_tool check, refusal text and all.
 *
 * Also refuse any Galaxy write aimed at a history another user owns. Galaxy
 * stops that for an ordinary key, but an admin key can write anywhere, and an
 * agent that moves the whole job -- inputs and target together -- into someone
 * else's history gets past the input check above.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { galaxyGet, getGalaxyConfig } from "./galaxy-api";
import type { GalaxyToolFamily } from "../../shared/galaxy-tool-family.js";

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Sources a history owns: where each answers its history_id, and how to ask for
 * little more than that.
 */
const HISTORY_SCOPED_SRCS: Record<string, { path: string; brief: string }> = {
  hda: { path: "/datasets", brief: "?keys=history_id,name" },
  hdca: { path: "/dataset_collections", brief: "?view=collection" },
};

/** How many references are looked up at once. */
const LOOKUPS = 4;

/** Every history-scoped reference in a tool payload, with the field that carries it. */
function hdaInputs(inputs: unknown): [string, string, string][] {
  const found: [string, string, string][] = [];
  const walk = (name: string, value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${name}[${index}]`, item));
    } else if (isRow(value)) {
      if (
        typeof value.src === "string" &&
        Object.hasOwn(HISTORY_SCOPED_SRCS, value.src) &&
        value.id
      ) {
        found.push([name, String(value.id), value.src]);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        walk(name ? `${name}.${key}` : key, item);
      }
    }
  };
  walk("", inputs || {});
  return found;
}

/**
 * Inputs that belong to a history other than `historyId`, each looked up once.
 * An id Galaxy won't resolve, or a lookup that fails, is not known to be
 * foreign: the run is left to report it.
 */
async function foreignInputs(inputs: unknown, historyId: string, signal?: AbortSignal) {
  const refs = hdaInputs(inputs);
  const distinct = [...new Set(refs.map(([, id, src]) => `${src}/${id}`))];
  const found = new Map<string, Row>();
  const lookup = async () => {
    for (let ref = distinct.pop(); ref !== undefined; ref = distinct.pop()) {
      const [src, id] = [ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)];
      // `.` and `..` would name a parent path, not an id.
      if (/^(\.|%2e){0,2}$/i.test(id)) continue;
      const { path, brief } = HISTORY_SCOPED_SRCS[src];
      try {
        const detail = await galaxyGet(`${path}/${encodeURIComponent(id)}${brief}`, signal);
        if (isRow(detail)) found.set(ref, detail);
      } catch {
        // Fail open: a Galaxy that can't answer here can't be shown to disagree.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUPS, distinct.length) }, lookup));
  return refs.flatMap(([input, id, src]) => {
    const detail = found.get(`${src}/${id}`);
    const where = detail?.history_id;
    return where && where !== historyId
      ? [{ input, supplied_id: id, history_id: where, name: detail?.name ?? null }]
      : [];
  });
}

/**
 * Galaxy tools that write into the history named by their `history_id`: run a
 * job there, upload into it, invoke a workflow into it, edit it, or attach a
 * page to it. Each one leaves `history_id` optional or defaults it to a history
 * of the user's own, so only an explicit id is checked.
 */
const HISTORY_WRITERS: ReadonlySet<string> = new Set([
  "run_tool",
  "run_user_tool",
  "invoke_workflow",
  "upload_file",
  "upload_file_from_url",
  "update_history",
  "create_page",
]);

/**
 * Orbit's own tools that write into an explicit `history_id`; not galaxy-ops
 * operations, so not in the family. Pushing an unbound notebook creates a page
 * attached to that history, the same write as create_page.
 */
const ORBIT_WRITERS: ReadonlySet<string> = new Set([
  "galaxy_upload_local_file",
  "notebook_push_to_galaxy",
]);

/** How long the shared who-am-I lookup may take; no one caller's signal owns it. */
const CURRENT_USER_TIMEOUT_MS = 15_000;

/**
 * The signed-in user's id, remembered for the credentials it was asked with: a
 * /connect or profile switch changes the URL or key, and the next check asks
 * again. Only an answer is kept, so a failed lookup is retried next time.
 */
let currentUser: { url: string; apiKey: string; id: Promise<string | null> } | undefined;

/** Forget the signed-in user, as a new session must. */
export function resetGalaxyCurrentUser(): void {
  currentUser = undefined;
}

function currentUserId(signal?: AbortSignal): Promise<string | null> {
  const config = getGalaxyConfig();
  if (!config) return Promise.resolve(null);
  if (currentUser?.url === config.url && currentUser.apiKey === config.apiKey) {
    return untilAborted(currentUser.id, signal);
  }
  const entry = {
    ...config,
    // Shared by every check until it settles, so it runs on its own timeout: one
    // aborted tool call must not hand a null to another one waiting on it.
    id: galaxyGet<unknown>("/users/current", AbortSignal.timeout(CURRENT_USER_TIMEOUT_MS)).then(
      (user) => (isRow(user) && typeof user.id === "string" && user.id ? user.id : null),
      () => null,
    ),
  };
  currentUser = entry;
  // An anonymous answer or a failure is not worth keeping.
  void entry.id.then((id) => {
    if (id === null && currentUser === entry) currentUser = undefined;
  });
  return untilAborted(entry.id, signal);
}

/** `pending`, or null as soon as `signal` aborts. */
function untilAborted<T>(pending: Promise<T | null>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const abort = () => resolve(null);
    signal.addEventListener("abort", abort, { once: true });
    void pending.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    });
  });
}

/**
 * Whether Galaxy names an owner of `historyId` other than the signed-in user. Fails open: no credentials, a lookup that fails, an
 * anonymous session or a history with no named owner can't be shown to belong
 * to someone else, so the write is left to Galaxy.
 */
async function ownedByAnother(historyId: string, signal?: AbortSignal): Promise<boolean> {
  // `.` and `..` would name a parent path, not an id.
  if (/^(\.|%2e){0,2}$/i.test(historyId)) return false;
  const [me, history] = await Promise.all([
    currentUserId(signal),
    galaxyGet<unknown>(`/histories/${encodeURIComponent(historyId)}?keys=id,user_id`, signal).catch(
      () => null,
    ),
  ]);
  if (!me || !isRow(history)) return false;
  // A 200 for some other resource is not an answer about this history.
  // Galaxy decodes hex ids in either case and answers in lowercase.
  if (history.id !== undefined && String(history.id).toLowerCase() !== historyId.toLowerCase()) {
    return false;
  }
  const owner = history.user_id;
  return typeof owner === "string" && owner !== "" && owner !== me;
}

function otherOwnerRefusal(historyId: string, family: GalaxyToolFamily) {
  return {
    block: true,
    reason:
      `Refused: history ${historyId} belongs to another Galaxy user, not to ` +
      "the account this session is signed in as. Don't run jobs, upload, or change anything " +
      `in someone else's history: use a history of the user's own -- take its id from ` +
      `${family.tool("get_histories")}, or make one with ${family.tool("create_history")}. ` +
      "If the user really means to work in that history, ask them first before trying again.",
  };
}

export function registerGalaxyHistoryGuard(pi: ExtensionAPI, family: GalaxyToolFamily): void {
  pi.on("session_start", () => {
    resetGalaxyCurrentUser();
  });
  pi.on("tool_call", async (event, ctx) => {
    const tool = family.toolName(event.toolName);
    const writes =
      (tool !== undefined && HISTORY_WRITERS.has(tool)) || ORBIT_WRITERS.has(event.toolName);
    if (!writes) return;
    const args = event.input as Row;
    if (typeof args.history_id !== "string" || !args.history_id) return;
    const [another, foreign] = await Promise.all([
      ownedByAnother(args.history_id, ctx?.signal),
      tool === "run_tool"
        ? foreignInputs(args.inputs, args.history_id, ctx?.signal)
        : Promise.resolve([]),
    ]);
    if (another) return otherOwnerRefusal(args.history_id, family);
    if (!foreign.length) return;
    return {
      block: true,
      reason:
        `Refused: these inputs are in another history, not in history ${args.history_id} ` +
        `where this job runs: ${JSON.stringify(foreign)}. An id from another history is ` +
        "usually the wrong one: take the input's `id` from get_history_contents for this " +
        "history. If the user does mean that data, say which history it is in and ask them " +
        "to copy it into this one in Galaxy, then use the copy's id.",
    };
  });
}
