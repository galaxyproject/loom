import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ReplayTool {
  id: string;
  name: string;
  resultText?: string;
  isError?: boolean;
}

export interface ReplaySegment {
  role: "user" | "assistant";
  text: string;
  tools?: ReplayTool[];
}

type ContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  toolCallId?: string;
  output?: { content?: Array<{ text?: string }> };
  isError?: boolean;
};

// Mirror pi-coding-agent's on-disk encoding: strip leading slash, then replace
// remaining path separators / drive colons with `-`, wrap in `--`.
// See session-manager.js:213 in @mariozechner/pi-coding-agent.
function sessionsDir(cwd: string): string {
  const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(os.homedir(), ".pi", "agent", "sessions", encoded);
}

function newestSessionFile(cwd: string): string | null {
  const dir = sessionsDir(cwd);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = path.join(dir, f);
      return { path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path ?? null;
}

// The shell (Orbit) injects a synthetic "Session started. Current directory: ..."
// user turn at session start. Don't replay it.
function isBootstrapPrompt(text: string): boolean {
  return /^Session started\. Current directory:/.test(text);
}

/**
 * Read the newest on-disk session for `cwd` and turn it into a compact replay.
 * Returns up to the last `maxSegments` user/assistant turns.
 */
export function loadSessionHistory(
  cwd: string,
  options: { maxSegments?: number } = {},
): ReplaySegment[] {
  const file = newestSessionFile(cwd);
  if (!file) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const results = new Map<string, { text: string; isError: boolean }>();
  const pending: Array<{ role: "user" | "assistant"; text: string; tools: ReplayTool[] }> = [];

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type !== "message") continue;
    const msg = evt.message as { role?: string; content?: unknown } | undefined;
    const role = msg?.role;
    if (role !== "user" && role !== "assistant") continue;
    const blocks: ContentBlock[] = Array.isArray(msg?.content)
      ? (msg!.content as ContentBlock[])
      : [];

    // Tool results travel in role=user messages; stash them for attachment.
    if (role === "user") {
      for (const b of blocks) {
        if (b.type === "toolResult" && b.toolCallId) {
          const text = b.output?.content?.map((c) => c.text ?? "").join("") ?? "";
          results.set(b.toolCallId, { text, isError: Boolean(b.isError) });
        }
      }
      const hasText = blocks.some((b) => b.type === "text");
      if (!hasText) continue;
    }

    let text = "";
    const tools: ReplayTool[] = [];
    for (const b of blocks) {
      if (b.type === "text") text += b.text ?? "";
      else if (b.type === "toolCall" && b.id && b.name) tools.push({ id: b.id, name: b.name });
    }

    if (role === "user") {
      if (!text.trim() || isBootstrapPrompt(text)) continue;
      pending.push({ role, text, tools });
    } else {
      if (!text.trim() && tools.length === 0) continue;
      pending.push({ role, text, tools });
    }
  }

  for (const seg of pending) {
    for (const t of seg.tools) {
      const r = results.get(t.id);
      if (r) {
        t.resultText = r.text;
        t.isError = r.isError;
      }
    }
  }

  const max = options.maxSegments ?? 200;
  return pending
    .slice(-max)
    .map((p) => ({ role: p.role, text: p.text, tools: p.tools.length ? p.tools : undefined }));
}
