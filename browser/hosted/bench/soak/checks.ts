/**
 * What the fault scripts check, read from the database and the stand-ins rather than from what a
 * page happened to receive: the stored transcript, whether the conversation is idle, and which Galaxy
 * requests went out as whom.
 */
import { decodeJwt } from "jose";

import { getConversation } from "../../src/dispatch/conversations";
import { storedSnapshot } from "../../src/server/snapshot";
import type { Stack } from "./stack";

interface ModelMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; name?: string; id?: string }>;
}
export interface Entry {
  id: number;
  kind: string;
  model?: ModelMessage[];
}

const textOf = (m: ModelMessage) =>
  typeof m.content === "string" ? m.content : m.content.flatMap((c) => (c.type === "text" ? [c.text ?? ""] : [])).join("");

export async function transcript(stack: Stack, conversationId: string): Promise<Entry[]> {
  const conversation = await getConversation(stack.pool, conversationId);
  if (!conversation) throw new Error(`No conversation ${conversationId}`);
  return (await storedSnapshot(stack.pool, conversation)).entries as unknown as Entry[];
}

/** The transcript as one short line per entry, for failure reports. */
export function brief(entries: Entry[]): string[] {
  return entries
    .filter((e) => e.kind !== "pi.system")
    .map((e) => {
      const parts = (e.model ?? []).map((m) =>
        typeof m.content === "string"
          ? m.content.slice(0, 50)
          : m.content.map((c) => (c.type === "toolCall" ? `call ${c.name}` : (c.text ?? c.type).slice(0, 40))).join(" "),
      );
      return `${e.id} ${e.kind}: ${parts.join(" | ")}`;
    });
}

/**
 * Problems with a transcript the script sent `tags` into, each tag once: every tag must appear in
 * exactly one user entry, every tool call must have exactly one result, and each user message's run
 * must end in exactly one plain answer.
 */
export function transcriptProblems(entries: Entry[], tags: readonly string[]): string[] {
  const problems: string[] = [];
  const shown = entries.filter((e) => e.kind !== "pi.system");
  const users = shown.filter((e) => e.kind === "pi.user").map((e) => (e.model ?? []).map(textOf).join("\n"));
  for (const tag of tags) {
    const n = users.filter((u) => u.includes(tag)).length;
    const inside = users.join("\n").split(tag).length - 1;
    if (n !== 1 || inside !== 1) problems.push(`message ${tag} appears ${inside} time(s) in ${n} user entr(ies)`);
  }
  // Split at user entries; each segment is one run's answer.
  let segment: Entry[] = [];
  const runs: Entry[][] = [];
  for (const e of shown) {
    if (e.kind === "pi.user") {
      if (segment.length) runs.push(segment);
      segment = [e];
    } else segment.push(e);
  }
  if (segment.length) runs.push(segment);
  for (const run of runs) {
    const head = (run[0]?.model ?? []).map(textOf).join(" ").slice(0, 40);
    const calls = run.filter((e) => e.kind === "pi.assistant" && (e.model ?? []).some((m) => typeof m.content !== "string" && m.content.some((c) => c.type === "toolCall")));
    const results = run.filter((e) => e.kind === "pi.tool-result");
    const answers = run.filter((e) => e.kind === "pi.assistant" && !calls.includes(e));
    if (results.length !== calls.length) problems.push(`run "${head}": ${calls.length} tool call(s) but ${results.length} result(s)`);
    if (answers.length !== 1) problems.push(`run "${head}": ${answers.length} final answers`);
  }
  return problems;
}

/** Idle: no turn holds the user's loop, nothing waits in the inbox, nothing is marked interrupted. */
export async function idle(stack: Stack, conversationId: string): Promise<boolean> {
  const { rows } = await stack.pool.query<{ busy: boolean }>(
    `SELECT c.interrupted
         OR EXISTS (SELECT 1 FROM orbit_inbox i WHERE i.conversation_id = c.id)
         OR EXISTS (SELECT 1 FROM orbit_live_loops l WHERE l.conversation_id = c.id) AS busy
       FROM orbit_conversations c WHERE c.id = $1`,
    [conversationId],
  );
  return rows[0]?.busy === false;
}

/** Wait until the conversation is idle and its transcript holds every tag with an answer after it. */
export async function settled(stack: Stack, conversationId: string, tags: readonly string[], timeoutMs = 60_000): Promise<Entry[]> {
  const deadline = Date.now() + timeoutMs;
  let entries: Entry[] = [];
  for (;;) {
    entries = await transcript(stack, conversationId).catch(() => entries);
    const last = entries.filter((e) => e.kind !== "pi.system").at(-1);
    const answered = last?.kind === "pi.assistant" && (last.model ?? []).every((m) => typeof m.content === "string" || m.content.every((c) => c.type !== "toolCall"));
    const all = tags.every((t) => entries.some((e) => e.kind === "pi.user" && (e.model ?? []).some((m) => textOf(m).includes(t))));
    if (answered && all && (await idle(stack, conversationId).catch(() => false))) return entries;
    if (Date.now() > deadline) {
      throw new Error(`Conversation ${conversationId} didn't settle in ${timeoutMs} ms:\n  ${brief(entries).join("\n  ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The Galaxy requests that went out as `sub`, by the access token they carried. */
export function galaxyRequestsOf(stack: Stack, sub: string, since = 0): Array<{ method: string; path: string; at: number }> {
  return stack.standIn.seen.filter((s) => s.to === "galaxy" && s.at >= since && subOf(s.authorization) === sub);
}

export function subOf(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  try {
    return decodeJwt(authorization.slice(7)).sub;
  } catch {
    return undefined;
  }
}

/** How many times Galaxy was asked to delete a history: the side effect that must never repeat. */
export function deletes(stack: Stack, historyId: string): number {
  return stack.standIn.seen.filter((s) => s.to === "galaxy" && s.method === "PUT" && s.path === `/api/histories/${historyId}`).length;
}

/** The lease generation of the conversation's store: one per holder that has taken it. */
export async function leaseGen(stack: Stack, conversationId: string): Promise<number> {
  const { rows } = await stack.pool.query<{ lease_gen: string }>(
    "SELECT s.lease_gen FROM orbit_conversations c JOIN durable_stores s ON s.store_id = c.store_id WHERE c.id = $1",
    [conversationId],
  );
  return Number(rows[0]?.lease_gen ?? 0);
}
