/**
 * The agent worker under VITE_ORBIT_BRAIN=orbit: the page protocol worker.ts speaks, answered by
 * Orbit's brain (extensions/orbit) on pi-host instead of the browser's own. The runtime (model,
 * compaction, storage, conversations) is the same Runtime; what differs is the brain installed in
 * it and that every conversation change goes through pi's session lifecycle.
 *
 * Its storage and its submission ledger are its own files (`-orbit`), so a flag build never reads
 * or rewrites what the default brain kept.
 */
import {
  InboxDoc,
  LiveDoc,
  MemoryStorage,
  watchEvents,
  type Conversation,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";

import { galaxyOpsEntry } from "../../../../../extensions/orbit/galaxy-ops-tools";
import { registeredGalaxyTools } from "../../../../../extensions/orbit/galaxy-tool-source";
import { createPage, listHistoryPages } from "../../../../../extensions/orbit/galaxy-pages-api";
import { pollGalaxyNow } from "../../../../../extensions/orbit/galaxy-poller";
import { galaxyBackgroundIdle } from "../../../../../extensions/orbit/galaxy-reconcile";
import { captureLateSubmission } from "../../../../../extensions/orbit/galaxy-submission-capture";
import { isSubmissionTool } from "../../../../../extensions/orbit/galaxy-submission";
import {
  addRecordStore,
  installedRecordStoreFor,
  setRecordStore,
} from "../../../../../extensions/orbit/record-store";
import { setCurrentHistoryId } from "../../../../../extensions/orbit/state";
import {
  createMemoryLedger,
  submissionLedger,
  type SubmissionLedger,
} from "../../../../../extensions/orbit/submission-ledger";
import { createPageRecordStore } from "../../../../../extensions/orbit/record-store-page";
import { registerArtifactKinds } from "../../artifacts/kinds";
import { DEFAULT_BRAND, noteTag, type Brand } from "../brand";
import { Binding, FollowUps, heldBy } from "../documents";
import { connectGalaxy, connectWeb, galaxyFetch } from "../galaxy";
import { galaxyTools } from "../galaxy-tools";
import { recordsOn, slugForSession, type RecordSummary } from "../notebook";
import type { SessionReason } from "../pi-host";
import { processTools } from "../processes";
import { browserPython, pythonTool } from "../python";
import { artifactsIn, context, Runtime, type Placement } from "../runtime";
import { holdStorage, openStorage } from "../storage";
import { galaxyOps, type AgentFlavor } from "../tools";
import { adaptTool, galaxyExtras, granted, type ShellToolHost } from "./adapter";
import type { OpenRequest, PageMessage, Waiting, WorkerMessage } from "../worker";
import { bootOrbit, type OrbitBoot } from "./boot";
import { setOrbitCwd } from "./env";
import { orbitGrant } from "./grants";
import { openLedger, opfsFile } from "./ledger";
import { ownSkillFiles } from "./skills";
import { orbitWatch, wakeups } from "./watch";

/** How long a conversation being left gets to finish its tool calls' end events. */
const SETTLE_MS = 30_000;
/** What a retried Galaxy request may wait in all: the watch's own backoff does the rest. */
const RETRY_BUDGET_MS = 5_000;

const post = (message: WorkerMessage) => self.postMessage(message);

let flavor: AgentFlavor = {};
let runtime: Runtime | undefined;
let orbit: OrbitBoot | undefined;
let conversation: Conversation | undefined;
/** The launch waiting on the user to pick one of its history's records, or a new session. */
let choosing: { placement: Placement; records: RecordSummary[]; unkept?: string } | undefined;

/** Orbit's records under their own slug, so neither brain offers the other's. */
const orbitBrand = (brand: Brand): Brand => ({ ...brand, id: `${brand.id}-orbit` });
let detach: (() => Promise<unknown>) | undefined;
let held: Waiting;
let readOnly = false;

/**
 * Confirmations waiting on the user. `run` marks one a run's tool call opened (it has the call's
 * signal); one a command opened (/approve) isn't the run's to withdraw when the run ends.
 */
const confirms = new Map<
  number,
  { conversation: ConversationId | undefined; run: boolean; resolve: (approved: boolean) => void }
>();
let confirmId = 0;

/** A confirm from Orbit, through the page's dialog; withdrawn when the call it gates stops. */
function ask(title: string, message: string, id: ConversationId | undefined, signal?: AbortSignal) {
  return new Promise<boolean | undefined>((resolve) => {
    if (signal?.aborted) {
      resolve(undefined);
      return;
    }
    const key = confirmId++;
    const settle = (answer: boolean | undefined) => {
      if (!confirms.delete(key)) return;
      resolve(answer);
    };
    confirms.set(key, { conversation: id, run: signal !== undefined, resolve: settle });
    signal?.addEventListener(
      "abort",
      () => {
        if (confirms.has(key)) post({ type: "withdrawn", id: key });
        settle(undefined);
      },
      { once: true },
    );
    post({ type: "confirm", id: key, title, message });
  });
}

/** Decline what `id` is waiting on, so its run can end; at a run's end, only what the run opened. */
function decline(id: ConversationId, runOnly = false) {
  for (const [key, waiting] of confirms) {
    if (waiting.conversation !== id || (runOnly && !waiting.run)) continue;
    post({ type: "withdrawn", id: key });
    waiting.resolve(false);
  }
}

/** The record page's key for a conversation: under its own pseudo directory. */
const pageKey = (id: ConversationId) => `/orbit/${id}/notebook.md`;

/** A conversation's watch, sleeping between ticks, woken when something asks it to look now. */
const { wake, woken } = wakeups();

let watch: ReturnType<typeof orbitWatch>;

const makeWatch = (pollMs?: number) =>
  orbitWatch({
    pollMs,
    bound: (id) => conversation?.id === id,
    recordKey: pageKey,
    poll: (options) => pollGalaxyNow(options),
    background: async (id) => {
      // A watch resumed while the runtime is still opening: busy, so it looks again shortly.
      if (!runtime) return true;
      const key = pageKey(id);
      // Not shown since this worker started (a reload): its store comes from its binding.
      if (!installedRecordStoreFor(key)) {
        const bound = await runtime!.harness.snapshot(Binding, id, context);
        // No page yet: nothing has been written that could move.
        if (!bound?.pageId) return false;
        addRecordStore(await recordFor(id));
      }
      return (await pollGalaxyNow({ recordKey: key })).inProgress > 0;
    },
    delivered: (recordKey, keys) => submissionLedger().delivered(recordKey, keys),
    settled: (id, settled) => {
      if (conversation?.id === id) post({ type: "settled", settled });
    },
    woken,
  });

/**
 * Make sure `id` has a watch, from outside any run, and have it look now: on attach (with
 * `recover`, so its first tick captures what the ledger holds answered and reconciles), and when
 * a reconcile saw a run end.
 */
async function watchNow(id: ConversationId, recover = false) {
  await runtime!.harness.commit((tx) => watch.ensure(tx, id, { recover }), context);
  wake(id);
}

/** Install `id`'s record store before its session starts. */
async function installRecord(id: ConversationId) {
  const store = await recordFor(id);
  setOrbitCwd(`/orbit/${id}`);
  setRecordStore(store);
}

/**
 * `id`'s record store. Its page is made on the first write that has something in it, attached to
 * the conversation's history and found again by slug, and bound in the conversation's Binding doc
 * before any content goes up.
 */
async function recordFor(id: ConversationId) {
  const harness = runtime!.harness;
  const bound = await harness.snapshot(Binding, id, context);
  const brand = flavor.brand ?? DEFAULT_BRAND;
  const slug = slugForSession(bound?.sessionId ?? String(id), orbitBrand(brand));
  return createPageRecordStore({
    key: pageKey(id),
    pageId: bound?.pageId,
    create: async () => {
      if (readOnly) throw new Error("A read-only launch keeps no record.");
      if (!bound?.historyId)
        throw new Error("This conversation has no Galaxy history to keep its record in.");
      const existing = (await listHistoryPages(bound.historyId)).find((page) => page.slug === slug);
      if (existing) return existing.id;
      return (
        await createPage({
          title: `${brand.name} record`,
          content: "",
          history_id: bound.historyId,
          slug,
        })
      ).id;
    },
    bind: async (pageId) => {
      await harness.commit(async (tx) => {
        (await tx.doc(Binding, id)).pageId = pageId;
      }, context);
    },
  });
}

/** Follow-ups queued for the user while the conversation is idle, and why. */
async function postHeld() {
  if (!runtime || !conversation) return;
  const id = conversation.id;
  const [policy, inbox, live] = await Promise.all([
    runtime.harness.snapshot(FollowUps, id, context),
    runtime.harness.snapshot(InboxDoc, id, context),
    runtime.harness.snapshot(LiveDoc, id, context),
  ]);
  const queued = !live?.run && (inbox?.items ?? []).some((item) => item.mode !== "write");
  const next: Waiting = queued ? heldBy(policy) : undefined;
  if (next !== held) {
    held = next;
    post({ type: "held", held });
  }
}

/**
 * Leave the conversation shown: decline what it waits on, end its run, stop admitting its tool
 * calls and give the running ones their end events, then end its session. A call still running
 * after that is captured into its own record when it finishes (onLateCompletion), and one the
 * worker doesn't live to see is in the ledger for the next attach.
 */
async function leave(left: Conversation) {
  decline(left.id);
  await runtime!.hold([left]);
  orbit!.host.quiesce(left.id);
  await orbit!.host.settle(left.id, SETTLE_MS);
  await galaxyBackgroundIdle();
  await orbit!.host.shutdown("new");
}

/**
 * Show `next` on the page and start its session in Orbit's brain. A switch that fails partway
 * goes back to the conversation that was shown, as switching back to it would, so the page is
 * never left on a conversation with no session; the failure is still reported.
 */
async function show(next: Conversation, reason: SessionReason) {
  const previous = conversation;
  try {
    if (previous && previous.id !== next.id) await leave(previous);
    await enter(next, reason);
  } catch (err) {
    if (previous && previous.id !== next.id) {
      try {
        await enter(previous, "resume");
      } catch (again) {
        // Nothing is shown now: messages wait for the next open rather than reach a half-bound one.
        conversation = undefined;
        console.error("[orbit] could not go back to the conversation that was shown:", again);
      }
    }
    throw err;
  }
}

async function enter(next: Conversation, reason: SessionReason) {
  await detach?.();
  detach = undefined;
  conversation = next;
  held = undefined;
  const harness = runtime!.harness;
  const stream = await watchEvents(harness, next.id, context);
  post({ type: "events", events: [stream.snapshot] });
  stream.start(async (events) => {
    post({ type: "events", events });
    if (events.some((e) => e.type === "run_end")) decline(next.id, true);
    await postHeld();
  });
  detach = () => stream.stop();
  await orbit!.host.attach(harness, next, context);
  await orbit!.host.start(reason);
  // After session_start, which clears it: the brain's history defaults (an upload, the init gate)
  // go to the history this conversation works in.
  setCurrentHistoryId((await harness.snapshot(Binding, next.id, context))?.historyId ?? null);
  // Whatever happened while the conversation wasn't shown, or before a reload, the watch's first
  // tick finds: answered submissions with no block, runs that finished, events never delivered.
  await watchNow(next.id, true);
  await postHeld();
}

async function open(request: OpenRequest) {
  // A second open (the other-tab handover) finds the brain already booted in this worker.
  if (orbit) return;
  const brand = flavor.brand ?? DEFAULT_BRAND;
  const capabilities = request.config.capabilities ?? ["llm", "local", "read", "write"];
  // Refused before anything is opened: a grant Orbit can't map is not one to guess at.
  readOnly = orbitGrant(capabilities).galaxy === "read";
  const galaxy = connectGalaxy({
    root: request.config.galaxy_root,
    credentials: request.config.credentials,
  });
  let unkept: string | undefined;
  const user = await galaxy.get("api/users/current").then(
    (body) => (typeof body?.id === "string" && body.id ? body.id : "anon"),
    (e) => {
      unkept = `the Galaxy user could not be identified: ${String((e as Error)?.message ?? e)}`;
      return undefined;
    },
  );
  let storage: Storage = new MemoryStorage();
  let ledger: SubmissionLedger = createMemoryLedger();
  if (user !== undefined) {
    await holdStorage(`${brand.id}:storage`, {
      steal: request.steal,
      waiting: () => post({ type: "waiting" }),
      lost: () => {
        post({ type: "lost" });
        self.close();
      },
    });
    ({ storage, unkept } = await openStorage(`${brand.id}-${user}-orbit`, brand.id));
    // Its own files, like the storage, and the same fallback to memory when they can't be opened.
    const opened = await openLedger(opfsFile(`${brand.id}-${user}-orbit-ledger.json`));
    ledger = opened.ledger;
    unkept ??= opened.unkept;
  }
  const url = new URL(galaxy.root, self.location.href).href.replace(/\/+$/, "");
  watch = makeWatch(request.config.poll_ms);
  const python = browserPython(request.pyodideURL);
  const galaxyOptions = {
    root: galaxy.root,
    key: request.config.galaxy_key,
    credentials: request.config.credentials,
  };
  // The browser's own tools read the conversation a call runs in when it runs.
  const shell: ShellToolHost = {
    clients: (signal) => ({
      galaxy: connectGalaxy({ ...galaxyOptions, signal }),
      web: connectWeb(signal),
      ops: galaxyOps({ ...galaxyOptions, signal }),
      python: { ...python, run: (code) => python.run(code, signal) },
    }),
    conversation: () => conversation?.id,
    binding: async (id) => ({ ...((await runtime!.harness.snapshot(Binding, id, context)) ?? {}) }),
    rebind: async (id, changed) => {
      await runtime!.harness.commit(async (tx) => {
        Object.assign(await tx.doc(Binding, id), changed);
      }, context);
    },
    artifacts: async (id) => {
      const found = await runtime!.harness.conversation(id, context);
      return found ? artifactsIn(found, context) : [];
    },
  };
  // The core's own tools and the flavor's (Olit's visualizations), as the grant allows.
  const flavored = (flavor.tools?.() ?? []).filter((t) => granted(t, capabilities));
  const shellTools = [
    ...[pythonTool(brand.name), ...processTools()].filter((t) => granted(t, capabilities)),
    ...flavored,
  ];
  const callContext = async () => {
    const id = conversation?.id;
    const [binding, prior] = id
      ? await Promise.all([shell.binding(id), shell.artifacts(id)])
      : [{}, []];
    return { ...shell.clients(undefined), binding, artifacts: { prior, produced: [] } };
  };
  orbit = bootOrbit({
    capabilities,
    galaxy: {
      fetch: galaxyFetch({
        root: galaxy.root,
        key: request.config.galaxy_key,
        credentials: request.config.credentials,
        maxRetryWaitMs: RETRY_BUDGET_MS,
      }),
      url,
      ...(request.config.galaxy_key ? { key: request.config.galaxy_key } : {}),
    },
    ledger,
    // The grant filters these with every other Galaxy tool (upload_file is a writer).
    extras: galaxyExtras(galaxyTools(noteTag(brand)), shell, galaxyOpsEntry().operations),
    shellTools: shellTools.map((t) => adaptTool(t, shell)),
    layers: {
      brandName: brand.name,
      // Every registered tool that isn't Galaxy's: Orbit's own, the core's and the flavor's.
      shellTools: () => {
        const galaxy = new Set(registeredGalaxyTools().map((t) => t.name));
        return new Set(orbit!.host.tools.filter((name) => !galaxy.has(name)));
      },
      // As in the browser brain, only the flavor's tools place artifacts besides Galaxy's.
      placing: () => new Set(flavored.map((t) => t.name)),
      artifacts: () => (conversation ? shell.artifacts(conversation.id) : Promise.resolve([])),
    },
    flavorLayers: {
      brandName: brand.name,
      annotators: flavor.annotators,
      promptSections: flavor.promptSections,
      datasetId: async () =>
        conversation
          ? (await runtime!.harness.snapshot(Binding, conversation.id, context))?.datasetId
          : undefined,
      context: callContext,
    },
    ownSkills: ownSkillFiles(flavor.skills ?? {}, brand.id),
    secrets: () => [runtime?.apiKey].filter((s): s is string => typeof s === "string"),
    ui: {
      ask: async (request, id, signal) =>
        request.kind === "confirm" ? ask(request.title, request.message, id, signal) : undefined,
      notify: (text, level, id) => {
        // The page shows one conversation; a notice for another one (a late capture after a
        // switch, say) would land in the wrong chat.
        if (id !== undefined && id !== conversation?.id) {
          console.info(`[orbit] notice for conversation ${String(id)}:`, text);
          return;
        }
        post({ type: "notice", level, text, ...(id === undefined ? {} : { conversationId: id }) });
      },
    },
    tasks: [watch.task],
    pollWake: () => {
      if (conversation) void watchNow(conversation.id).catch(failed);
    },
    host: {
      models: { getModel: (provider, id) => runtime?.models?.getModel(provider, id) },
      // A submission makes sure its conversation has a watch, in the call's own commit.
      afterExecute: async (name, result, api, id) => {
        if (!isSubmissionTool(name) || result.isError) return;
        try {
          await api.commit((tx) => watch.ensure(tx, id), context);
          wake(id);
        } catch {
          // Refused under the run's abort mark (a Stop mid-call): ensure it from outside the run.
          await watchNow(id);
        }
      },
      beforeStart: installRecord,
      // Only a submission has anything to capture; any other late call is just finished.
      onLateCompletion: (_id, call, result) =>
        isSubmissionTool(call.name) ? captureLateSubmission(call.id, call.name, result) : undefined,
    },
  });
  runtime = await Runtime.open({
    storage,
    config: request.config,
    python,
    flavor,
    extensions: orbit.extensions,
  });
  if (request.saved) {
    return begin(await runtime.open(request.saved.document, request.saved.id), "resume", unkept);
  }
  const kept = await runtime.kept(request.placement);
  if (kept) return begin(kept, "resume", unkept);
  // As in the browser brain: the history's records say which sessions it had, and the user says
  // which one this is, if any.
  let records: RecordSummary[] = [];
  let recordsProblem: string | undefined;
  try {
    const historyId = request.placement.historyId;
    records = historyId ? await recordsOn(runtime.galaxy, historyId, orbitBrand(brand)) : [];
  } catch (e) {
    recordsProblem = String((e as Error)?.message ?? e);
  }
  if (records.length) {
    choosing = { placement: request.placement, records, unkept };
    post({ type: "recoverable", records });
    return;
  }
  return begin(await runtime.create(request.placement), "startup", unkept, recordsProblem);
}

async function begin(
  next: Conversation,
  reason: SessionReason,
  unkept?: string,
  recordsProblem?: string,
) {
  await show(next, reason);
  post({
    type: "ready",
    brain: "orbit",
    unkept,
    galaxy: runtime!.galaxyStatus,
    galaxyProblem: runtime!.galaxyProblem,
    recordsProblem,
  });
}

async function reply(id: number, work: () => Promise<unknown>) {
  try {
    post({ type: "reply", id, value: await work() });
  } catch (err) {
    post({ type: "reply", id, error: String((err as Error)?.message ?? err) });
  }
}

const failed = (err: unknown) =>
  post({ type: "failed", message: String((err as Error)?.message ?? err) });

let queue: Promise<unknown> = Promise.resolve();
function inOrder(work: () => Promise<unknown>) {
  queue = queue.then(work).catch(failed);
}

/** Run this worker as the agent on Orbit's brain, with what `agentFlavor` adds to the shell. */
export function startOrbitWorker(agentFlavor: AgentFlavor): void {
  flavor = agentFlavor;
  registerArtifactKinds(flavor.artifactKinds ?? []);
  self.onmessage = onMessage;
}

function onMessage({ data }: MessageEvent<PageMessage>) {
  if (data.type === "open") {
    open(data.request).catch(failed);
  } else if (data.type === "confirmed") {
    confirms.get(data.id)?.resolve(data.approved === true);
  } else if (data.type === "stop") {
    const stopped = conversation;
    if (!stopped) return;
    decline(stopped.id);
    inOrder(() => runtime!.hold([stopped]));
  } else {
    inOrder(() => handle(data));
  }
}

async function handle(data: PageMessage) {
  if (data.type === "submit") {
    const current = conversation!;
    const host = orbit!.host;
    const command =
      data.text.startsWith("/") && host.commands.has(data.text.slice(1).split(" ")[0]);
    // The user's own message lets settled work start runs again, as it does for the default
    // brain; a command (/pending, say) isn't a message to the agent.
    if (!command) {
      await current.commit(async (tx) => {
        Object.assign(await tx.doc(FollowUps, current.id), { automatic: 0, paused: false });
      }, context);
    }
    const submitted = await host.submit(data.text, { source: "interactive" });
    // A command, a handled input or a busy refusal starts no run, so no stream event will tell
    // the page it's idle again.
    if (!submitted) post({ type: "quiet" });
  } else if (data.type === "reset") {
    const left = conversation!;
    const bound = await runtime!.harness.snapshot(Binding, left.id, context);
    await show(
      await runtime!.create({ historyId: bound?.historyId, datasetId: bound?.datasetId }),
      "new",
    );
  } else if (data.type === "switch") {
    await reply(data.id, () => runtime!.switchModel(conversation!, data.config));
  } else if (data.type === "export") {
    await reply(data.id, () => runtime!.export(conversation!, data.title));
  } else if (data.type === "saved") {
    await reply(data.id, () => runtime!.saved(conversation!, data.savedId, data.document));
  } else if (data.type === "recover") {
    if (!choosing) return;
    const { placement, records, unkept } = choosing;
    choosing = undefined;
    const record = records.find((r) => r.pageId === data.pageId);
    await begin(
      await runtime!.create({ ...placement, ...(record ? { record } : {}) }),
      "startup",
      unkept,
    );
  }
}
