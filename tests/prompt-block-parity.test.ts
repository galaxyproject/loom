import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The browser's prompt.ts copied its blocks from context.ts, one `loom:` comment
// per copy, and they have drifted since. This is a report of that drift, not an
// equality check: each pair's diff and word overlap are pinned, so converging a
// block (or drifting it further) shows up as a change to the golden.
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: loadConfigMock }));

import { DEFAULT_SKILLS } from "../shared/loom-config.js";
import * as browser from "../browser/core/src/agent/prompt";
import {
  buildCurrentDateBlock,
  buildGalaxyContextBlock,
  buildNoLocalShellBlock,
  buildVerificationDisciplineBlock,
  setupContextInjection,
} from "../extensions/loom/context";
import { SRA_IMPORT_GUIDANCE } from "../extensions/loom/sra-import-gate";
import { GALAXY_PAGE_MARKDOWN_GUIDANCE } from "../extensions/loom/galaxy-page-markdown-guidance";
import { GALAXY_ARTIFACT_LINK_GUIDANCE } from "../extensions/loom/galaxy-artifact-link-guidance";

const PROMPT_TS = path.join(__dirname, "..", "browser", "core", "src", "agent", "prompt.ts");
const TODAY = new Date(2026, 9, 11, 12, 0, 0);
const MODEL = "claude-test-model";
// A fence line is the fence alone; prose that merely starts with ```plan is not one.
const FENCE = /^\s*```[\w-]*\s*$/;

let agentDir: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-parity-agent-"));
  loadConfigMock.mockReturnValue({
    llm: { active: "anthropic", providers: { anthropic: { model: MODEL } } },
    skills: { repos: [...DEFAULT_SKILLS] },
  });
  for (const name of Object.keys(process.env)) {
    if (/^(ORBIT|LOOM|GALAXY)_/.test(name)) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(agentDir, { recursive: true, force: true });
});

/** The exports prompt.ts marks as copies, with the loom source each comment names. */
function markedCopies(): Array<{ name: string; source: string }> {
  const lines = fs.readFileSync(PROMPT_TS, "utf-8").split(/\r?\n/);
  const found: Array<{ name: string; source: string }> = [];
  lines.forEach((line, i) => {
    const marker = line.match(/^(?:\/\/|\/\*\*) loom: (.*?)(?: \*\/)?$/);
    if (!marker) return;
    for (const next of lines.slice(i + 1)) {
      const exported = next.match(/^export (?:const|function) (\w+)/);
      if (exported) {
        found.push({ name: exported[1], source: marker[1] });
        break;
      }
    }
  });
  return found;
}

/** A heading's section, up to the next heading of its level or above, outside code fences. */
function section(text: string, heading: string, without: string[] = []): string {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no ${heading} in the loom prompt`);
  const level = heading.match(/^#+/)![0].length;
  let fenced = false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fenced = !fenced;
    const h = !fenced && lines[i].match(/^(#+) /);
    if (h && (h[1].length <= level || without.includes(lines[i]))) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

async function loomPrompt(): Promise<string> {
  vi.stubEnv("GALAXY_URL", "https://galaxy.example.org");
  vi.stubEnv("GALAXY_API_KEY", "fixture-key");
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  setupContextInjection({ on: (e: string, h: never) => handlers.set(e, h) } as never);
  const result = (await handlers.get("before_agent_start")!(
    {},
    { cwd: agentDir, model: { id: MODEL }, ui: { notify: () => {} } },
  )) as { systemPrompt: string };
  vi.stubEnv("GALAXY_URL", undefined);
  vi.stubEnv("GALAXY_API_KEY", undefined);
  return result.systemPrompt;
}

function remoteOnly<T>(build: () => T): T {
  vi.stubEnv("ORBIT_LOCAL_SHELL", "off");
  try {
    return build();
  } finally {
    vi.stubEnv("ORBIT_LOCAL_SHELL", undefined);
  }
}

/** What each marked browser export is compared against on the loom side. */
function pairs(prompt: string): Record<string, { browser: string; loom: string }> {
  const s = (heading: string, without?: string[]) => section(prompt, heading, without);
  return {
    NO_LOCAL_SHELL: { browser: browser.NO_LOCAL_SHELL, loom: remoteOnly(buildNoLocalShellBlock) },
    galaxyTerminology: { browser: browser.galaxyTerminology(), loom: s("### Galaxy terminology") },
    GETTING_DATA_IN: {
      browser: browser.GETTING_DATA_IN,
      loom: s("### Getting data into a Galaxy history"),
    },
    IMPORTING_SRA: { browser: browser.IMPORTING_SRA, loom: SRA_IMPORT_GUIDANCE },
    INVOKING_WORKFLOW: {
      browser: browser.INVOKING_WORKFLOW,
      loom: s("### Invoking a Galaxy workflow"),
    },
    EXECUTING_A_STEP: { browser: browser.EXECUTING_A_STEP, loom: s("### Executing a Galaxy step") },
    FINDING_A_WORKFLOW: {
      browser: browser.FINDING_A_WORKFLOW,
      loom: s("### Finding a community workflow (IWC)"),
    },
    DRAFTING_A_PLAN: { browser: browser.DRAFTING_A_PLAN, loom: s("### Drafting a new plan") },
    GALAXY_UNAVAILABLE: {
      browser: browser.GALAXY_UNAVAILABLE,
      loom: remoteOnly(buildGalaxyContextBlock),
    },
    OPERATING_DISCIPLINE: {
      browser: browser.OPERATING_DISCIPLINE,
      loom: s("## Operating discipline"),
    },
    VERIFICATION: { browser: browser.VERIFICATION, loom: buildVerificationDisciplineBlock() },
    PLAN_CONVENTION: {
      browser: browser.PLAN_CONVENTION,
      loom: s("## Project model and plan sections"),
    },
    PARAMETER_REVIEW: { browser: browser.PARAMETER_REVIEW, loom: s("## Parameter review") },
    CHAT_FORMATTING: {
      browser: browser.CHAT_FORMATTING,
      // The artifact-link guidance rides inside loom's block; it is its own pair.
      loom: s("## Chat formatting", ["### Clickable Galaxy artifacts"]),
    },
    ARTIFACT_LINKS: { browser: browser.ARTIFACT_LINKS, loom: GALAXY_ARTIFACT_LINK_GUIDANCE },
    chatFormattingBlock: {
      browser: browser.chatFormattingBlock("https://galaxy.example.org"),
      loom: s("## Chat formatting"),
    },
    RECORD_WRITES: { browser: browser.RECORD_WRITES, loom: s("## Notebook writes") },
    GALAXY_PAGE_MARKDOWN: {
      browser: browser.GALAXY_PAGE_MARKDOWN,
      loom: GALAXY_PAGE_MARKDOWN_GUIDANCE,
    },
    currentDateBlock: {
      browser: browser.currentDateBlock(TODAY),
      loom: buildCurrentDateBlock(TODAY),
    },
    activeModelBlock: {
      browser: browser.activeModelBlock(MODEL, "anthropic"),
      loom: s("## Active LLM"),
    },
  };
}

/**
 * Differences nobody needs to read about: dashes, the MCP tool prefix, edge whitespace, and
 * where a paragraph happens to wrap. Each paragraph or list item becomes one line, so the
 * diff shows what a block says rather than how it was filled.
 */
function normalize(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  let joinable = false;
  for (const raw of text.replaceAll("—", "--").replaceAll("mcp__galaxy__", "").split("\n")) {
    const line = raw.trimEnd();
    const fence = FENCE.test(line);
    const starts = fence || fenced || line === "" || /^\s*(#|[-*] |\d+\. |\|)/.test(line);
    if (joinable && !starts) {
      out[out.length - 1] += ` ${line.trim()}`;
    } else {
      out.push(line);
    }
    if (fence) fenced = !fenced;
    joinable = !fenced && !fence && line !== "" && !/^\s*(#|\|)/.test(line);
  }
  while (out.length && out[0] === "") out.shift();
  while (out.length && out.at(-1) === "") out.pop();
  return out;
}

/** A unified line diff with two lines of context, as its lines. */
function unifiedDiff(a: string[], b: string[], context = 2): string[] {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Array<{ op: " " | "-" | "+"; line: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: " ", line: a[i], ai: i++, bi: j++ });
    } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ op: "-", line: a[i], ai: i++, bi: j });
    } else {
      ops.push({ op: "+", line: b[j], ai: i, bi: j++ });
    }
  }
  const changed = ops.map((o, k) => (o.op === " " ? -1 : k)).filter((k) => k >= 0);
  const out: string[] = [];
  let k = 0;
  while (k < changed.length) {
    const from = Math.max(0, changed[k] - context);
    let to = changed[k];
    while (k + 1 < changed.length && changed[k + 1] - to <= 2 * context + 1) to = changed[++k];
    to = Math.min(ops.length - 1, to + context);
    k++;
    const hunk = ops.slice(from, to + 1);
    const aLen = hunk.filter((o) => o.op !== "+").length;
    const bLen = hunk.filter((o) => o.op !== "-").length;
    out.push(`@@ -${hunk[0].ai + 1},${aLen} +${hunk[0].bi + 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.op}${o.line}`);
  }
  return out;
}

function wordSimilarity(a: string[], b: string[]): number {
  const words = (lines: string[]) =>
    new Set(
      lines
        .join(" ")
        .toLowerCase()
        .match(/[a-z0-9_]+/g),
    );
  const wa = words(a);
  const wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union ? Math.round((shared / union) * 1000) / 1000 : 1;
}

describe("browser prompt blocks against the loom blocks they were copied from", () => {
  it("pairs every marked copy", async () => {
    const table = pairs(await loomPrompt());
    expect(
      markedCopies()
        .map((c) => c.name)
        .sort(),
    ).toEqual(Object.keys(table).sort());
  });

  it("reports each pair's drift", async () => {
    const table = pairs(await loomPrompt());
    const report = {
      about:
        "browser = prompt.ts, loom = the block its loom: comment names. Both sides normalized " +
        "first: em dashes as --, mcp__galaxy__ dropped, each paragraph or list item unwrapped " +
        "onto one line, trailing and edge blank lines trimmed. " +
        "The diff runs browser -> loom; similarity is the Jaccard overlap of lowercased words.",
      pairs: markedCopies().map(({ name, source }) => {
        const b = normalize(table[name].browser);
        const l = normalize(table[name].loom);
        return {
          browser: name,
          loom: source,
          identical: b.join("\n") === l.join("\n"),
          similarity: wordSimilarity(b, l),
          diff: unifiedDiff(b, l),
        };
      }),
    };
    await expect(`${JSON.stringify(report, null, 2)}\n`).toMatchFileSnapshot(
      "__surface__/prompt-block-parity.json",
    );
  });
});
