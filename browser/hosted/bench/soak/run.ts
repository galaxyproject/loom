/**
 * The soak and fault-injection harness (brief H14): simulated users through the real sign-in and
 * WebSocket against the built host, with the host killed, restarted, cut off from Postgres and so on
 * mid-conversation, and the H14 measurements taken along the way. See README.md.
 *
 *   cd browser/hosted && npm run build && npm run soak [-- scenario ...] [--n 1,4,8] [--turns 12] [--verbose]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { testDatabase } from "../../src/test-db";
import { User, type Tab } from "./client";
import { brief, deletes, galaxyRequestsOf, idle, leaseGen, settled, transcript, transcriptProblems } from "./checks";
import { Stack } from "./stack";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const verbose = args.includes("--verbose");
const PORT = Number(flag("port") ?? 7931);
if (PORT < 7900 || PORT > 8099) throw new Error("Use a port in 7900-8099");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Outcome {
  readonly name: string;
  readonly pass: boolean;
  readonly problems: string[];
  readonly notes: Record<string, unknown>;
  readonly ms: number;
}

class Scenario {
  readonly problems: string[] = [];
  readonly notes: Record<string, unknown> = {};
  #n = 0;
  constructor(
    readonly name: string,
    readonly stack: Stack,
  ) {}
  /** A unique tag for a message, so the transcript check can find it exactly once. */
  tag(user: string): string {
    return `[${user}#${++this.#n}]`;
  }
  check(ok: boolean, problem: string): void {
    if (!ok) this.problems.push(problem);
  }
  async transcriptOk(conversationId: string, tags: string[]): Promise<void> {
    const entries = await transcript(this.stack, conversationId);
    const problems = transcriptProblems(entries, tags);
    for (const p of problems) this.problems.push(`${conversationId.slice(0, 8)}: ${p}`);
    if (problems.length && verbose) console.log(`    transcript:\n      ${brief(entries).join("\n      ")}`);
  }
}

let dbCounter = 0;
async function withStack<T>(options: { accessTtlS?: number }, run: (stack: Stack) => Promise<T>): Promise<T> {
  const stack = await Stack.start({ database: testDatabase(`orbit_soak_${process.pid}_${++dbCounter}`), port: PORT, verbose, ...options });
  try {
    return await run(stack);
  } finally {
    await stack.close();
  }
}

async function signedIn(stack: Stack, sub: string): Promise<{ user: User; conversationId: string; tab: Tab }> {
  const user = new User(stack, sub);
  await user.signIn();
  const conversationId = await user.newConversation();
  const tab = await user.tab(conversationId);
  await tab.until((m) => m.find((x) => x.type === "ready"));
  return { user, conversationId, tab };
}

/** One message to its run's end, as the page sees it; answers a confirm with `approve` if one comes. */
async function say(tab: Tab, text: string, approve?: boolean): Promise<{ ms: number; confirms: number }> {
  const from = tab.received.length;
  const started = performance.now();
  tab.submit(text);
  if (approve !== undefined) {
    const confirm = await tab.until((m) => m.find((x) => x.type === "confirm"), 30_000, from);
    if (confirm.type === "confirm") tab.confirm(confirm.id, approve);
  }
  await tab.until((m) => m.find((x) => x.type === "events" && x.events.some((e) => e.type === "run_end")) ?? m.find((x) => x.type === "failed"), 60_000, from);
  const failed = tab.received.slice(from).find((x) => x.type === "failed");
  if (failed && failed.type === "failed") throw new Error(`"${text}" failed: ${failed.message}`);
  return { ms: performance.now() - started, confirms: tab.received.slice(from).filter((x) => x.type === "confirm").length };
}

/** Wait for a Galaxy request matching `path` from the stand-in, after `since`. */
async function galaxySaw(stack: Stack, method: string, path: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!stack.standIn.seen.some((s) => s.to === "galaxy" && s.method === method && s.path === path)) {
    if (Date.now() > deadline) throw new Error(`Galaxy never saw ${method} ${path}`);
    await sleep(20);
  }
}

/** A fresh tab on the conversation once the host is back. */
async function reopen(user: User, conversationId: string): Promise<Tab> {
  const tab = await user.tab(conversationId);
  await tab.until((m) => m.find((x) => x.type === "ready"));
  return tab;
}

// ---------------------------------------------------------------------------------------------------
// Soak: N users at once, each a multi-turn conversation with tool calls and destructive confirms.

interface SoakResult {
  n: number;
  turns: number;
  hostIdleRssMb: number;
  hostPeakRssMb: number;
  hostEndRssMb: number;
  rssPerTurnMb: number[];
  /** The first user's turn times, in order, to see whether a long conversation slows down. */
  msPerTurn: number[];
  /** Host process spawn to listening. */
  hostListeningMs: number;
  /** A new conversation's first message to its first model request: dispatch plus a worker's boot. */
  coldStartToFirstModelMs: number;
  turnMsMedian: number;
  turnMsP95: number;
  /** Median turn time by what the turn did. */
  turnMsByKind: Record<string, number>;
  galaxyRequestsPerSession: number[];
  galaxyRequestsPerTurn: number;
  /** The first user's Galaxy requests by method and path, ids folded. */
  galaxyByPath: Record<string, number>;
  leaseGenPerSession: number[];
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
};

/** The script each simulated user runs: reads, a plain question, a delete approved and one declined. */
function script(sub: string, turns: number): Array<{ text: string; approve?: boolean; deletes?: string; spares?: string }> {
  const steps: Array<{ text: string; approve?: boolean; deletes?: string; spares?: string }> = [];
  for (let i = 0; steps.length < turns; i++) {
    const kind = i % 4;
    if (kind === 0) steps.push({ text: `READ_HISTORY r${sub.replace(/\W/g, "")}${i}` });
    else if (kind === 1) steps.push({ text: "what is in my history?" });
    else if (kind === 2) steps.push({ text: `DELETE_HISTORY d${sub.replace(/\W/g, "")}${i}`, approve: true, deletes: `d${sub.replace(/\W/g, "")}${i}` });
    else steps.push({ text: `DELETE_HISTORY k${sub.replace(/\W/g, "")}${i}`, approve: false, spares: `k${sub.replace(/\W/g, "")}${i}` });
  }
  return steps;
}

async function soak(n: number, turns: number): Promise<{ outcome: Outcome; result: SoakResult }> {
  const started = performance.now();
  return withStack({}, async (stack) => {
    const s = new Scenario(`soak n=${n}`, stack);
    const { listeningMs } = await stack.startHost();
    await sleep(1500);
    const hostIdleRssMb = stack.hostRssMb()!;
    let peak = hostIdleRssMb;
    const sampler = setInterval(() => {
      const rss = stack.hostRssMb();
      if (rss && rss > peak) peak = rss;
    }, 100);
    const users = await Promise.all(Array.from({ length: n }, (_, i) => signedIn(stack, `soak-u${i}`)));
    const rssPerTurnMb: number[] = [];
    const msPerTurn: number[] = [];
    const turnMs: number[] = [];
    const byKind: Record<string, number[]> = {};
    let firstModelMs = NaN;
    try {
      await Promise.all(
        users.map(async ({ user, conversationId, tab }, u) => {
          const tags: string[] = [];
          const steps = script(user.sub, turns);
          for (const [i, step] of steps.entries()) {
            const tag = s.tag(`u${u}`);
            tags.push(tag);
            const before = Date.now();
            const { ms, confirms } = await say(tab, `${tag} ${step.text}`, step.approve);
            turnMs.push(ms);
            const kind = step.approve === true ? "delete approved" : step.approve === false ? "delete declined" : step.text.startsWith("READ") ? "read" : "chat";
            (byKind[kind] ??= []).push(ms);
            if (i === 0 && u === 0) {
              const first = stack.standIn.seen.find((x) => x.to === "model" && x.at >= before);
              firstModelMs = first ? first.at - before : NaN;
            }
            if (u === 0) rssPerTurnMb.push(Math.round(stack.hostRssMb()!));
            if (u === 0) msPerTurn.push(Math.round(ms));
            s.check(confirms === (step.approve === undefined ? 0 : 1), `${user.sub}: "${step.text}" showed ${confirms} confirms`);
            if (step.deletes) s.check(deletes(stack, step.deletes) === 1, `${step.deletes} deleted ${deletes(stack, step.deletes)} times`);
            if (step.spares) s.check(deletes(stack, step.spares) === 0, `${step.spares} deleted though declined`);
          }
          await settled(stack, conversationId, tags);
          await s.transcriptOk(conversationId, tags);
        }),
      );
    } finally {
      clearInterval(sampler);
    }
    const galaxyRequestsPerSession = users.map(({ user }) => galaxyRequestsOf(stack, user.sub).length);
    const leaseGenPerSession = await Promise.all(users.map(({ conversationId }) => leaseGen(stack, conversationId)));
    // Two users' requests never carry each other's token: every Galaxy request is someone's.
    const anonymous = stack.standIn.seen.filter((x) => x.to === "galaxy" && !x.authorization).length;
    s.check(anonymous === 0, `${anonymous} Galaxy requests carried no token`);
    const result: SoakResult = {
      n,
      turns,
      hostIdleRssMb: Math.round(hostIdleRssMb),
      hostPeakRssMb: Math.round(peak),
      hostEndRssMb: Math.round(stack.hostRssMb()!),
      rssPerTurnMb,
      msPerTurn,
      hostListeningMs: Math.round(listeningMs),
      coldStartToFirstModelMs: Math.round(firstModelMs),
      turnMsMedian: Math.round(quantile(turnMs, 0.5)),
      turnMsP95: Math.round(quantile(turnMs, 0.95)),
      turnMsByKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, Math.round(quantile(v, 0.5))])),
      galaxyRequestsPerSession,
      galaxyRequestsPerTurn: Math.round((galaxyRequestsPerSession.reduce((a, b) => a + b, 0) / (n * turns)) * 10) / 10,
      galaxyByPath: galaxyRequestsOf(stack, users[0]!.user.sub).reduce<Record<string, number>>((by, r) => {
        const key = `${r.method} ${r.path.replace(/\/(histories|pages)\/[^/]+/, "/$1/:id")}`;
        by[key] = (by[key] ?? 0) + 1;
        return by;
      }, {}),
      leaseGenPerSession,
    };
    Object.assign(s.notes, result);
    return { outcome: finish(s, started), result };
  });
}

function finish(s: Scenario, started: number): Outcome {
  return { name: s.name, pass: s.problems.length === 0, problems: s.problems, notes: s.notes, ms: Math.round(performance.now() - started) };
}

// ---------------------------------------------------------------------------------------------------
// Faults. Each runs on its own fresh stack.

type Fault = (s: Scenario, stack: Stack) => Promise<void>;

/** Kill the host after a run's Galaxy read and before the model answers it; the sweeper resumes it. */
const killMidTurn =
  (signal: NodeJS.Signals): Fault =>
  async (s, stack) => {
    await stack.startHost();
    const { user, conversationId, tab } = await signedIn(stack, "fault-a");
    const bystander = await signedIn(stack, "fault-a2");
    const t1 = s.tag("a");
    await say(tab, `${t1} READ_HISTORY warm`);
    const t2 = s.tag("a");
    tab.submit(`${t2} READ_HISTORY cut PAUSE_AFTER_TOOL`);
    await galaxySaw(stack, "GET", "/api/histories/cut");
    await sleep(300);
    const modelCallsBefore = stack.standIn.modelCalls();
    const code = await stack.stopHost(signal);
    s.notes.exit = code ?? signal;
    await stack.startHost();
    const restartAt = Date.now();
    // Another user, untouched by the crash, mustn't wait on the cut-off conversation's recovery.
    const other = await reopen(bystander.user, bystander.conversationId);
    const tb = s.tag("a2");
    const bystanderTurn = say(other, `${tb} READ_HISTORY bystander`).then(
      () => (s.notes.bystanderMs = Date.now() - restartAt),
      (e: Error) => s.problems.push(`another user stalled after the restart: ${e.message}`),
    );
    // Nobody sends anything: the sweeper alone has to finish the turn.
    const entries = await settled(stack, conversationId, [t1, t2], 60_000).catch((e: Error) => {
      s.problems.push(`not resumed without a new message: ${e.message.split("\n")[0]}`);
      return undefined;
    });
    s.notes.resumeMs = entries ? Date.now() - restartAt : undefined;
    await bystanderTurn;
    s.check(((s.notes.bystanderMs as number) ?? Infinity) < 10_000, `another user's turn took ${s.notes.bystanderMs} ms after the restart`);
    s.notes.modelCallsAfterRestart = stack.standIn.modelCalls() - modelCallsBefore;
    s.notes.galaxyReadsOfCut = stack.standIn.galaxyCalls("GET", "/api/histories/cut");
    const tab2 = await reopen(user, conversationId);
    const t3 = s.tag("a");
    await say(tab2, `${t3} DELETE_HISTORY after`, true).catch((e: Error) => s.problems.push(`unusable afterwards: ${e.message}`));
    s.check(deletes(stack, "after") === 1, `delete after restart ran ${deletes(stack, "after")} times`);
    await settled(stack, conversationId, [t1, t2, t3]).catch((e: Error) => s.problems.push(e.message));
    await s.transcriptOk(conversationId, [t1, t2, t3]);
    s.notes.leaseGen = await leaseGen(stack, conversationId);
  };

/** Restart while a destructive confirm waits: it's asked again after the restart and answered once. */
const restartPendingConfirm =
  (signal: NodeJS.Signals): Fault =>
  async (s, stack) => {
    await stack.startHost();
    const { user, conversationId, tab } = await signedIn(stack, "fault-b");
    const t1 = s.tag("b");
    const from = tab.received.length;
    tab.submit(`${t1} DELETE_HISTORY pending`);
    const first = await tab.until((m) => m.find((x) => x.type === "confirm"), 30_000, from);
    await stack.stopHost(signal);
    // The old page answers into a dead socket: that yes must not count.
    if (first.type === "confirm" && tab.isOpen) tab.confirm(first.id, true);
    await tab.closed;
    await stack.startHost();
    const restartAt = Date.now();
    const tab2 = await user.tab(conversationId);
    const again = await tab2.until((m) => m.find((x) => x.type === "confirm"), 90_000).catch(() => undefined);
    s.notes.reaskMs = again ? Date.now() - restartAt : undefined;
    s.check(again !== undefined, "confirm not asked again after the restart");
    s.check(deletes(stack, "pending") === 0, "deleted before the user answered the second ask");
    if (again?.type === "confirm") {
      tab2.confirm(again.id, true);
      // An impatient double click.
      tab2.confirm(again.id, true);
    }
    await settled(stack, conversationId, [t1]).catch((e: Error) => s.problems.push(e.message));
    await sleep(500);
    s.check(deletes(stack, "pending") === 1, `history deleted ${deletes(stack, "pending")} times`);
    s.check(tab2.confirmsShown().length === 1, `the new tab was shown ${tab2.confirmsShown().length} confirms`);
    const t2 = s.tag("b");
    await say(tab2, `${t2} READ_HISTORY later`).catch((e: Error) => s.problems.push(`unusable afterwards: ${e.message}`));
    await s.transcriptOk(conversationId, [t1, t2]);
  };

/** The socket drops mid-run and mid-confirm; a new one picks up the stream and the ask. */
const socketDrop: Fault = async (s, stack) => {
  await stack.startHost();
  const { user, conversationId, tab } = await signedIn(stack, "fault-c");
  const t1 = s.tag("c");
  tab.submit(`${t1} READ_HISTORY drop PAUSE_AFTER_TOOL`);
  await galaxySaw(stack, "GET", "/api/histories/drop");
  tab.ws.terminate();
  const tab2 = await reopen(user, conversationId);
  await tab2.until((m) => m.find((x) => x.type === "events" && x.events.some((e) => e.type === "run_end")), 30_000).catch(() =>
    s.problems.push("reconnected tab never saw the run end"),
  );
  const t2 = s.tag("c");
  const from = tab2.received.length;
  tab2.submit(`${t2} DELETE_HISTORY dropconfirm`);
  const ask = await tab2.until((m) => m.find((x) => x.type === "confirm"), 30_000, from);
  tab2.ws.terminate();
  const tab3 = await reopen(user, conversationId);
  // The ask follows ready in its own frame.
  await tab3.until((m) => m.find((x) => x.type === "confirm"), 10_000).catch(() => undefined);
  await sleep(300);
  const shown = tab3.confirmsShown();
  s.check(shown.length === 1, `reconnected tab shown ${shown.length} confirms`);
  s.check(shown[0]?.id === (ask.type === "confirm" ? ask.id : -1), "a different confirm after reconnecting");
  if (shown[0]) tab3.confirm(shown[0].id, true);
  await settled(stack, conversationId, [t1, t2]).catch((e: Error) => s.problems.push(e.message));
  s.check(deletes(stack, "dropconfirm") === 1, `deleted ${deletes(stack, "dropconfirm")} times`);
  await s.transcriptOk(conversationId, [t1, t2]);
};

/** Two tabs on one conversation: both see the ask, the first answer wins, the second does nothing. */
const twoTabs: Fault = async (s, stack) => {
  await stack.startHost();
  const { user, conversationId, tab } = await signedIn(stack, "fault-d");
  const other = await reopen(user, conversationId);
  const t1 = s.tag("d");
  const from1 = tab.received.length;
  const from2 = other.received.length;
  tab.submit(`${t1} DELETE_HISTORY shared`);
  const a1 = await tab.until((m) => m.find((x) => x.type === "confirm"), 30_000, from1);
  const a2 = await other.until((m) => m.find((x) => x.type === "confirm"), 30_000, from2).catch(() => undefined);
  s.check(a2 !== undefined, "the second tab wasn't shown the confirm");
  if (a1.type === "confirm") tab.confirm(a1.id, true);
  const closed = await other.until((m) => m.find((x) => x.type === "withdrawn"), 10_000, from2).catch(() => undefined);
  s.check(closed !== undefined, "the second tab's dialog wasn't closed after the first tab answered");
  // A late click on the dialog the first tab already answered.
  if (a2?.type === "confirm") other.confirm(a2.id, false);
  await other.until((m) => m.find((x) => x.type === "events" && x.events.some((e) => e.type === "run_end")), 30_000, from2);
  await sleep(300);
  s.check(deletes(stack, "shared") === 1, `deleted ${deletes(stack, "shared")} times`);
  const t2 = s.tag("d");
  const seenBy1 = tab.received.length;
  await say(other, `${t2} READ_HISTORY fromtwo`);
  s.check(
    tab.received.slice(seenBy1).some((x) => x.type === "events" && x.events.some((e) => e.type === "run_end")),
    "the first tab didn't see the second tab's turn",
  );
  await settled(stack, conversationId, [t1, t2]).catch((e: Error) => s.problems.push(e.message));
  await s.transcriptOk(conversationId, [t1, t2]);
};

/** One user's refresh fails (their Keycloak session revoked); the others keep refreshing and working. */
const tokenExpiry: Fault = async (s, stack) => {
  await stack.startHost();
  const users = await Promise.all(["tok-a", "tok-b", "tok-c"].map((sub) => signedIn(stack, sub)));
  const tags = users.map(() => [] as string[]);
  for (const [i, u] of users.entries()) {
    const t = s.tag(u.user.sub);
    tags[i]!.push(t);
    await say(u.tab, `${t} READ_HISTORY before${i}`);
  }
  stack.keycloak.revokeUser("tok-a");
  // Past the access token's life less the host's 30 s skew, so the next Galaxy call refreshes.
  await sleep(6_000);
  const refreshesBefore = stack.keycloak.refreshes;
  const victim = users[0]!;
  const vTag = s.tag("tok-a");
  // The refresh fails inside the turn: the model hears Galaxy refuse with the sign-in wording, and
  // the session is gone, so the page's next message is turned away with a sign-in prompt.
  await say(victim.tab, `${vTag} READ_HISTORY victim`).catch((e: Error) => s.problems.push(`revoked user's turn: ${e.message}`));
  const told = brief(await transcript(stack, victim.conversationId)).some((l) => l.includes("pi.tool-result") && /sign in again/i.test(l));
  const result = (await transcript(stack, victim.conversationId)).find((e) => e.kind === "pi.tool-result" && JSON.stringify(e.model).includes("victim"));
  s.check(told || /sign in again/i.test(JSON.stringify(result ?? "")), "the revoked user's tool result doesn't say to sign in again");
  const vFrom = victim.tab.received.length;
  victim.tab.submit(`${s.tag("tok-a")} READ_HISTORY refused`);
  const refused = await victim.tab
    .until((m) => m.find((x) => x.type === "failed" && /signed out/i.test(x.message)), 10_000, vFrom)
    .catch(() => undefined);
  s.check(refused !== undefined, "the revoked user's next message wasn't turned away with a sign-in prompt");
  for (const [i, u] of users.slice(1).entries()) {
    const t = s.tag(u.user.sub);
    tags[i + 1]!.push(t);
    await say(u.tab, `${t} READ_HISTORY after${i}`).catch((e: Error) => s.problems.push(`${u.user.sub} stopped working: ${e.message}`));
  }
  s.notes.refreshes = stack.keycloak.refreshes - refreshesBefore;
  s.check(galaxyRequestsOf(stack, "tok-a").every((r) => r.path !== "/api/histories/victim"), "the revoked user's call reached Galaxy");
  for (const [i, u] of users.slice(1).entries()) {
    await settled(stack, u.conversationId, tags[i + 1]!).catch((e: Error) => s.problems.push(e.message));
    await s.transcriptOk(u.conversationId, tags[i + 1]!);
  }
  // Signing in again makes the conversation usable, and the user's loop wasn't left held.
  await victim.user.signIn();
  const tab = await reopen(victim.user, victim.conversationId);
  const t = s.tag("tok-a");
  await say(tab, `${t} READ_HISTORY again`).catch((e: Error) => s.problems.push(`revoked user unusable after signing in again: ${e.message}`));
  s.notes.victimTranscript = brief(await transcript(stack, victim.conversationId)).slice(-6);
};

/** Restart with the kill switch on: nothing runs, the user is told; off again, the cut turn resumes. */
const killSwitch: Fault = async (s, stack) => {
  await stack.startHost();
  const { user, conversationId, tab } = await signedIn(stack, "fault-e");
  const t1 = s.tag("e");
  tab.submit(`${t1} READ_HISTORY switched PAUSE_AFTER_TOOL`);
  await galaxySaw(stack, "GET", "/api/histories/switched");
  await stack.stopHost("SIGTERM");
  await stack.startHost({ ORBIT_TURNS_DISABLED: "Orbit is paused for maintenance." });
  const modelCalls = stack.standIn.modelCalls();
  const tab2 = await reopen(user, conversationId);
  const t2 = s.tag("e");
  tab2.submit(`${t2} READ_HISTORY whileoff`);
  const failed = await tab2.until((m) => m.find((x) => x.type === "failed"), 10_000).catch(() => undefined);
  s.check(failed?.type === "failed" && failed.message.includes("maintenance"), "no kill-switch notice on submit");
  await sleep(3_000);
  s.check(stack.standIn.modelCalls() === modelCalls, `${stack.standIn.modelCalls() - modelCalls} model calls while turned off`);
  s.check(!(await idle(stack, conversationId)), "the interrupted mark was lost under the kill switch");
  await stack.stopHost("SIGTERM");
  await stack.startHost();
  await settled(stack, conversationId, [t1]).catch((e: Error) => s.problems.push(`not resumed after the switch went off: ${e.message}`));
  const tab3 = await reopen(user, conversationId);
  const t3 = s.tag("e");
  await say(tab3, `${t3} hello again`).catch((e: Error) => s.problems.push(`unusable afterwards: ${e.message}`));
  // The refused message was refused, never queued.
  const entries = await transcript(stack, conversationId);
  s.check(!brief(entries).some((l) => l.includes(t2)), "the message refused under the kill switch ran later");
  await s.transcriptOk(conversationId, [t1, t3]);
};

/** Postgres drops every host connection mid-run; the runs and the conversations carry on. */
const postgresBlip: Fault = async (s, stack) => {
  await stack.startHost();
  const users = await Promise.all(["pg-a", "pg-b", "pg-c"].map((sub) => signedIn(stack, sub)));
  const tags = users.map((u) => [s.tag(u.user.sub)]);
  for (const [i, u] of users.entries()) u.tab.submit(`${tags[i]![0]} READ_HISTORY blip${i} PAUSE_AFTER_TOOL`);
  await galaxySaw(stack, "GET", "/api/histories/blip2");
  const { rows } = await stack.pool.query<{ n: string }>(
    "SELECT count(pg_terminate_backend(pid)) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name <> 'soak-harness'",
  );
  s.notes.terminated = Number(rows[0]!.n);
  for (const [i, u] of users.entries()) {
    await settled(stack, u.conversationId, tags[i]!, 60_000).catch((e: Error) => s.problems.push(`after the blip: ${e.message.split("\n")[0]}`));
  }
  s.check(stack.host!.child.exitCode === null, `the host exited (${stack.host!.child.exitCode})`);
  for (const [i, u] of users.entries()) {
    const t = s.tag(u.user.sub);
    tags[i]!.push(t);
    const tab = u.tab.isOpen ? u.tab : await reopen(u.user, u.conversationId);
    await say(tab, `${t} DELETE_HISTORY postblip${i}`, true).catch((e: Error) => s.problems.push(`${u.user.sub} unusable after the blip: ${e.message}`));
    s.check(deletes(stack, `postblip${i}`) === 1, `postblip${i} deleted ${deletes(stack, `postblip${i}`)} times`);
    await settled(stack, u.conversationId, tags[i]!).catch((e: Error) => s.problems.push(e.message));
    await s.transcriptOk(u.conversationId, tags[i]!);
  }
};

/** Wait for a host log line containing `text`. */
async function hostLogged(stack: Stack, text: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!stack.log.some((l) => l.includes(text))) {
    if (Date.now() > deadline) throw new Error(`The host never logged "${text}"`);
    await sleep(50);
  }
}

/** Whether any worker holds the conversation's lease. */
async function leaseHeld(stack: Stack, conversationId: string): Promise<boolean> {
  const { rowCount } = await stack.pool.query(
    "SELECT 1 FROM orbit_leases l JOIN orbit_conversations c ON c.store_id = l.store_id WHERE c.id = $1",
    [conversationId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The page closes and the conversation sits quiet: its worker is released. Opening it again shows the
 * stored transcript without a worker; the next message boots one that resumes from the store, with no
 * greeting, and a delete after it runs once.
 */
const idleRelease: Fault = async (s, stack) => {
  await stack.startHost({ ORBIT_IDLE_RELEASE_SECONDS: "2" });
  const { user, conversationId, tab } = await signedIn(stack, "fault-f");
  const t1 = s.tag("f");
  await say(tab, `${t1} READ_HISTORY beforeidle`);
  // Open in a page, it stays past the quiet period.
  await sleep(3_500);
  s.check(!stack.log.some((l) => l.includes(`releasing ${conversationId}`)), "released while a page had it open");
  s.notes.rssLiveMb = Math.round(stack.hostRssMb() ?? 0);
  tab.close();
  await tab.closed;
  const closedAt = Date.now();
  await hostLogged(stack, `releasing ${conversationId}`, 15_000);
  s.notes.releasedAfterMs = Date.now() - closedAt;
  const deadline = Date.now() + 15_000;
  while ((await leaseHeld(stack, conversationId)) && Date.now() < deadline) await sleep(100);
  s.check(!(await leaseHeld(stack, conversationId)), "the lease wasn't given back after the release");
  await sleep(1_000);
  s.notes.rssReleasedMb = Math.round(stack.hostRssMb() ?? 0);
  const genReleased = await leaseGen(stack, conversationId);
  const modelCalls = stack.standIn.modelCalls();
  const tab2 = await reopen(user, conversationId);
  await sleep(1_000);
  s.check(!(await leaseHeld(stack, conversationId)), "reopening a released conversation started a worker");
  s.check(stack.standIn.modelCalls() === modelCalls, "the model was called before the next message");
  const t2 = s.tag("f");
  const cold = await say(tab2, `${t2} DELETE_HISTORY afteridle`, true).catch((e: Error) => {
    s.problems.push(`after the release: ${e.message}`);
    return undefined;
  });
  s.notes.firstTurnAfterReleaseMs = cold && Math.round(cold.ms);
  s.check(cold?.confirms === 1, `the delete after the release asked ${cold?.confirms} times`);
  const t3 = s.tag("f");
  await say(tab2, `${t3} hello again`).catch((e: Error) => s.problems.push(`unusable afterwards: ${e.message}`));
  await settled(stack, conversationId, [t1, t2, t3]).catch((e: Error) => s.problems.push(e.message));
  s.check(deletes(stack, "afteridle") === 1, `deleted ${deletes(stack, "afteridle")} times`);
  s.check((await leaseGen(stack, conversationId)) === genReleased + 1, "the next message didn't take the lease once, on a fresh worker");
  // The delete's call, its answer, and hello: nothing else, so no greeting.
  s.check(stack.standIn.modelCalls() - modelCalls === 3, `${stack.standIn.modelCalls() - modelCalls} model calls after the release, expected 3`);
  await s.transcriptOk(conversationId, [t1, t2, t3]);
};

/**
 * A destructive confirm goes unanswered: the conversation pauses, the page's dialog is withdrawn, and
 * the user's other conversation runs meanwhile. Coming back asks again, once; a yes deletes once.
 */
const askPause: Fault = async (s, stack) => {
  await stack.startHost({ ORBIT_ASK_PAUSE_SECONDS: "3" });
  const { user, conversationId, tab } = await signedIn(stack, "fault-g");
  const t1 = s.tag("g");
  const from = tab.received.length;
  tab.submit(`${t1} DELETE_HISTORY unanswered`);
  const first = await tab.until((m) => m.find((x) => x.type === "confirm"), 30_000, from);
  const askedAt = Date.now();
  const firstId = first.type === "confirm" ? first.id : -1;
  await tab.until((m) => m.find((x) => x.type === "withdrawn" && x.id === firstId), 30_000, from).catch(() =>
    s.problems.push("the unanswered dialog was never withdrawn"),
  );
  s.notes.pausedAfterMs = Date.now() - askedAt;
  s.check(
    tab.received.slice(from).some((m) => m.type === "notice" && /paused/i.test(m.text)),
    "the page wasn't told the conversation paused",
  );
  // A late yes from the old dialog must not count.
  tab.confirm(firstId, true);
  await sleep(500);
  s.check(deletes(stack, "unanswered") === 0, "deleted without an answer to a live ask");
  const { rows } = await stack.pool.query<{ paused: boolean; interrupted: boolean }>(
    "SELECT paused, interrupted FROM orbit_conversations WHERE id = $1",
    [conversationId],
  );
  s.check(rows[0]?.paused === true && rows[0]?.interrupted === false, `marked ${JSON.stringify(rows[0])} rather than paused`);
  s.check(!(await leaseHeld(stack, conversationId)), "the paused conversation still holds a worker");
  // The user's live loop is free: their other conversation runs now, not after the ask.
  const otherId = await user.newConversation();
  const otherTab = await reopen(user, otherId);
  const to = s.tag("g2");
  const other = await say(otherTab, `${to} READ_HISTORY meanwhile`).catch((e: Error) => {
    s.problems.push(`the user's other conversation: ${e.message}`);
    return undefined;
  });
  s.notes.otherConversationMs = other && Math.round(other.ms);
  s.check(!otherTab.received.some((m) => m.type === "notice" && /waiting/i.test(m.text)), "the other conversation waited on the paused one");
  otherTab.close();
  tab.close();
  await tab.closed;
  // Coming back asks again, once, even with two tabs opening at once.
  const backAt = Date.now();
  const [tab2, tab3] = await Promise.all([user.tab(conversationId), user.tab(conversationId)]);
  const again = await tab2.until((m) => m.find((x) => x.type === "confirm"), 30_000).catch(() => undefined);
  s.notes.reaskMs = again ? Date.now() - backAt : undefined;
  s.check(again !== undefined, "not asked again on coming back");
  await sleep(1_000);
  s.check(tab2.confirmsShown().length === 1, `the returning tab was shown ${tab2.confirmsShown().length} confirms`);
  s.check(tab3.confirmsShown().length === 1, `the second returning tab was shown ${tab3.confirmsShown().length} confirms`);
  s.check(deletes(stack, "unanswered") === 0, "deleted before the second ask was answered");
  if (again?.type === "confirm") tab2.confirm(again.id, true);
  await settled(stack, conversationId, [t1]).catch((e: Error) => s.problems.push(e.message));
  await sleep(500);
  s.check(deletes(stack, "unanswered") === 1, `history deleted ${deletes(stack, "unanswered")} times`);
  const t2 = s.tag("g");
  await say(tab2, `${t2} READ_HISTORY afterpause`).catch((e: Error) => s.problems.push(`unusable afterwards: ${e.message}`));
  await s.transcriptOk(conversationId, [t1, t2]);
  await s.transcriptOk(otherId, [to]);
};

const FAULTS: Record<string, { fault: Fault; accessTtlS?: number }> = {
  "sigkill-mid-turn": { fault: killMidTurn("SIGKILL") },
  "sigterm-mid-turn": { fault: killMidTurn("SIGTERM") },
  "sigterm-pending-confirm": { fault: restartPendingConfirm("SIGTERM") },
  "sigkill-pending-confirm": { fault: restartPendingConfirm("SIGKILL") },
  "socket-drop": { fault: socketDrop },
  "two-tabs": { fault: twoTabs },
  "token-refresh-failure": { fault: tokenExpiry, accessTtlS: 35 },
  "kill-switch": { fault: killSwitch },
  "postgres-blip": { fault: postgresBlip },
  "idle-release": { fault: idleRelease },
  "ask-pause": { fault: askPause },
};

async function runFault(name: string): Promise<Outcome> {
  const { fault, accessTtlS } = FAULTS[name]!;
  const started = performance.now();
  return withStack({ accessTtlS }, async (stack) => {
    const s = new Scenario(name, stack);
    try {
      await fault(s, stack);
    } catch (error) {
      s.problems.push(`aborted: ${(error as Error).message}`);
    }
    if (s.problems.length && !verbose) s.notes.hostLogTail = stack.log.filter((l) => !l.startsWith("  ")).slice(-15);
    return finish(s, started);
  });
}

// ---------------------------------------------------------------------------------------------------

const wanted = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const ns = (flag("n") ?? "1,4,8").split(",").map(Number);
const turns = Number(flag("turns") ?? 12);
const names = wanted.length ? wanted : ["soak", ...Object.keys(FAULTS)];
const outcomes: Outcome[] = [];
const soaks: SoakResult[] = [];
for (const name of names) {
  if (name === "soak") {
    for (const n of ns) {
      console.log(`soak n=${n}, ${turns} turns each`);
      const { outcome, result } = await soak(n, turns).catch((error: Error) => ({
        outcome: { name: `soak n=${n}`, pass: false, problems: [error.message], notes: {}, ms: 0 },
        result: undefined as unknown as SoakResult,
      }));
      outcomes.push(outcome);
      if (result) soaks.push(result);
      report(outcome);
    }
    continue;
  }
  if (!FAULTS[name]) throw new Error(`No scenario ${name}; have soak, ${Object.keys(FAULTS).join(", ")}`);
  console.log(name);
  const outcome = await runFault(name);
  outcomes.push(outcome);
  report(outcome);
}

function report(outcome: Outcome): void {
  console.log(`  ${outcome.pass ? "PASS" : "FAIL"} ${outcome.name} (${(outcome.ms / 1000).toFixed(1)} s)`);
  for (const p of outcome.problems) console.log(`    - ${p}`);
  for (const [k, v] of Object.entries(outcome.notes)) console.log(`    ${k}: ${JSON.stringify(v)}`);
}

const out = join(HERE, "..", "..", ".scratch", `soak-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
try {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), node: process.version, outcomes, soaks }, null, 2));
  console.log(`results: ${out}`);
} catch {
  // The console has it all anyway.
}
const failed = outcomes.filter((o) => !o.pass).length;
console.log(`${outcomes.length - failed}/${outcomes.length} passed`);
process.exit(failed ? 1 : 0);
