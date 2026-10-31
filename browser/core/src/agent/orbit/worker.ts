/**
 * The agent worker: the page protocol worker.ts speaks, answered by Orbit's brain
 * (extensions/orbit) on pi-host. The runtime holds the model, compaction, storage and the
 * conversations; every conversation change goes through pi's session lifecycle.
 *
 * What it takes from where it runs comes through an OrbitWorkerEnv: a browser worker's
 * (browser-env.ts, from worker.ts), or Node's for Headless (headless.ts), which drives the same
 * protocol in-process.
 *
 * Its storage and its submission ledger are its own files (`-orbit`), apart from what the
 * browser's earlier brain kept.
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
import { DEFAULT_BRAND, type Brand } from "../brand";
import { Binding, FollowUps, heldBy } from "../documents";
import { connectGalaxy, connectWeb, galaxyFetch } from "../galaxy";
import { galaxyTools } from "../galaxy-extras";
import { recordsOn, slugForSession, type RecordSummary } from "../records";
import type { SessionReason } from "../pi-host";
import type { Submission } from "@earendil-works/pi-durable";
import { processTools } from "../processes";
import { pythonTool } from "../python";
import { artifactsIn, context, Runtime, type Placement } from "../runtime";
import type { AgentFlavor } from "../tools";
import type { Python } from "../tool";
import { adaptTool, galaxyExtras, granted, type ShellToolHost } from "./adapter";
import type { OpenRequest, PageMessage, Waiting, WorkerMessage } from "../worker";
import { bootOrbit, closeOrbit, type OrbitBoot } from "./boot";
import { setOrbitCwd } from "./env";
import { orbitGrant } from "./grants";
import { ownSkillFiles, type SkillReader } from "./skills";
import { orbitWatch, wakeups } from "./watch";

/** How long a conversation being left gets to finish its tool calls' end events. */
const SETTLE_MS = 30_000;
/** What a retried Galaxy request may wait in all: the watch's own backoff does the rest. */
const RETRY_BUDGET_MS = 5_000;

/** What the worker takes from where it runs. */
export interface OrbitWorkerEnv {
  post(message: WorkerMessage): void;
  /** The address a relative Galaxy root resolves against. */
  base(): string;
  python(request: OpenRequest): Python;
  /** Storage and the submission ledger for this Galaxy user; memory when the user is unknown. */
  keep(
    brand: Brand,
    user: string | undefined,
    request: OpenRequest,
  ): Promise<{ storage: Storage; ledger: SubmissionLedger; unkept?: string }>;
  /** The directory each conversation's record key and side files go under. */
  root: string;
  /** How a shipped skill body is read, where fetching it beside the bundle won't do (Node). */
  readSkill?: SkillReader;
  /** Where a provider's key may come from besides the config (Node's environment). */
  vars?: Record<string, string | undefined>;
}

/** Where the worker runs: set by startOrbitWorker before anything else. */
let env: OrbitWorkerEnv;
const post = (message: WorkerMessage) => env.post(message);

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
const pageKey = (id: ConversationId) => `${env.root}/${id}/notebook.md`;

/** A conversation's watch, sleeping between ticks, woken when something asks it to look now. */
const { wake, woken, clear: clearWakeups } = wakeups();

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
  setOrbitCwd(`${env.root}/${id}`);
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
        // A reset made `next` its history's conversation; the one shown again is that again.
        await runtime!.continues(previous);
      } catch (again) {
        // Nothing is shown now: messages wait for the next open rather than reach a half-bound one.
        await detach?.();
        detach = undefined;
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

/** Bumped when the worker stops: an open still in flight from before then must not boot. */
let generation = 0;
let opening = false;
/** Bumped by each open that goes ahead: an earlier one still waiting is superseded by it. */
let attempt = 0;

/** An open another took over from: it stops without a word, the newer one answering the page. */
class Superseded extends Error {}

/** Throw if the worker stopped, or a newer open took over, since this open began. */
function current(started: { generation: number; attempt: number }) {
  if (started.generation !== generation)
    throw new Error("The worker stopped while the session was opening.");
  if (started.attempt !== attempt) throw new Superseded();
}

async function open(request: OpenRequest) {
  // Once booted, a second open (the other-tab handover) finds the brain here already. While one
  // is still booting, only "Use it here" goes ahead: the open it follows waits on the other tab's
  // lock, perhaps for good.
  if (orbit || (opening && !request.steal)) return;
  opening = true;
  const started = { generation, attempt: ++attempt };
  try {
    await boot(request, started);
  } catch (err) {
    if (!(err instanceof Superseded)) throw err;
  } finally {
    if (started.generation === generation && started.attempt === attempt) opening = false;
  }
}

async function boot(request: OpenRequest, started: { generation: number; attempt: number }) {
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
  const keeping = await env.keep(brand, user, request);
  current(started);
  const { storage, ledger } = keeping;
  unkept ??= keeping.unkept;
  const url = new URL(galaxy.root, env.base()).href.replace(/\/+$/, "");
  watch = makeWatch(request.config.poll_ms);
  const python = env.python(request);
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
    extras: galaxyExtras(galaxyTools(), shell),
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
      galaxyStatus: () => runtime?.galaxyStatus,
    },
    ownSkills: ownSkillFiles(flavor.skills ?? {}, brand.id),
    readSkill: env.readSkill,
    secrets: () =>
      [runtime?.apiKey, request.config.galaxy_key].filter(
        (s): s is string => typeof s === "string",
      ),
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
  const opened = await Runtime.open({
    storage,
    config: request.config,
    env: env.vars,
    brand,
    extensions: orbit.extensions,
  });
  try {
    current(started);
  } catch (err) {
    await opened.close();
    throw err;
  }
  runtime = opened;
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

/**
 * Run the agent on Orbit's brain where `environment` says, with what `agentFlavor` adds to the
 * shell: what it hands back takes the page's messages.
 */
export function startOrbitWorker(
  agentFlavor: AgentFlavor,
  environment: OrbitWorkerEnv,
): (message: PageMessage) => void {
  flavor = agentFlavor;
  env = environment;
  registerArtifactKinds(flavor.artifactKinds ?? []);
  return (data) => onMessage({ data } as MessageEvent<PageMessage>);
}

/**
 * End the shown conversation's session and forget the brain, so another can start in this process
 * (Headless, one session after another). A browser worker ends with its page instead.
 */
export async function stopOrbitWorker(): Promise<void> {
  try {
    if (conversation && orbit) await leave(conversation);
  } finally {
    await detach?.();
    detach = undefined;
    await runtime?.close();
    // Unconditionally: a boot that threw after installing the seams left no `orbit` to say so.
    closeOrbit();
    clearWakeups();
    generation++;
    opening = false;
    runtime = undefined;
    orbit = undefined;
    conversation = undefined;
    choosing = undefined;
    held = undefined;
    readOnly = false;
    confirms.clear();
    queue = Promise.resolve();
  }
}

/** The worker's state, for Headless: what a page reads off the protocol, read directly. */
export function orbitSession() {
  return { runtime, conversation, host: orbit?.host, open: opening || !!orbit || !!runtime };
}

/**
 * The user's message to the shown conversation: settled work may start runs again, unless it is
 * a command. What pi-host handed back, or nothing when no run starts (a command, a refusal).
 */
export async function submitText(text: string): Promise<Submission | undefined> {
  if (!conversation || !orbit) throw new Error("No conversation is shown to submit to.");
  const shown = conversation;
  const host = orbit.host;
  const command = text.startsWith("/") && host.commands.has(text.slice(1).split(" ")[0]);
  // The user's own message lets settled work start runs again; a command (/pending, say) isn't a
  // message to the agent.
  if (!command) {
    await shown.commit(async (tx) => {
      Object.assign(await tx.doc(FollowUps, shown.id), { automatic: 0, paused: false });
    }, context);
  }
  return host.submit(text, { source: "interactive" });
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
    const submitted = await submitText(data.text);
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
    if (!choosing) {
      // One the page sends twice is already answered; one with nothing shown would wait forever.
      if (!conversation) failed(new Error("No offered session is waiting to be chosen."));
      return;
    }
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
