import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LESSONS_OFF_POINTER,
  describeLessonsSwitch,
  isLessonsEnabled,
  isLessonsHardDisabled,
  setLessonsEnabled,
} from "../extensions/loom/lessons/enabled";
import { getLessonStore, resetLessonStore } from "../extensions/loom/lessons/store";
import { buildStepLessonNote, decideHintForEvent } from "../extensions/loom/lesson-hint";
import { buildReproductionLessonsContext } from "../extensions/loom/lessons/reproduction-index";
import {
  armLessonProposal,
  proposeLesson,
  resetLessonProposalArming,
} from "../extensions/loom/lessons/propose";
import { registerLessonCommand } from "../extensions/loom/lesson-command";
import { registerLessonNudge, resetLessonNudge } from "../extensions/loom/lesson-nudge";
import { registerLessonReplay } from "../extensions/loom/lessons/replay";
import { registerLessonProposalReplay } from "../extensions/loom/lessons/propose-replay";
import { appendActivityEvent, resetActivity } from "../extensions/loom/activity";
import { setNotebookPath } from "../extensions/loom/state";
import { envNames } from "../shared/orbit-env.js";
import { lessonFile } from "./lessons-fixture";

// One throwaway HOME per test, every env spelling of the switch cleared, so
// each case starts from the real default: no config, no env, off.
let dir: string;
let home: string;
let lessonsDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "LOOM_LESSONS_DIR",
  "LOOM_LESSON_REPLAY",
  "LOOM_LESSON_PROPOSAL_REPLAY",
  ...envNames("LESSONS"),
];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lessons-switch-"));
  home = path.join(dir, "home");
  lessonsDir = path.join(dir, "lessons");
  fs.mkdirSync(path.join(home, ".loom"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LOOM_LESSONS_DIR = lessonsDir;
  for (const name of envNames("LESSONS")) delete process.env[name];
  fs.writeFileSync(path.join(dir, "notebook.md"), "# nb\n");
  setNotebookPath(path.join(dir, "notebook.md"));
  resetActivity();
  resetLessonStore();
  resetLessonProposalArming();
  resetLessonNudge();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setNotebookPath(null);
  resetActivity();
  resetLessonStore();
  resetLessonProposalArming();
  resetLessonNudge();
  fs.rmSync(dir, { recursive: true, force: true });
});

const configPath = () => path.join(home, ".loom", "config.json");
const writeConfig = (obj: unknown) => fs.writeFileSync(configPath(), JSON.stringify(obj));
const readConfig = () => JSON.parse(fs.readFileSync(configPath(), "utf-8"));

const SIGNATURE = "no reference index registered for build";

function plantLesson(): void {
  fs.mkdirSync(path.join(lessonsDir, "galaxy-tools"), { recursive: true });
  fs.writeFileSync(
    path.join(lessonsDir, "galaxy-tools", "reference-index-not-registered.md"),
    lessonFile({
      title: "Reference index not registered for the chosen build",
      trigger: { signatures: `["${SIGNATURE}"]` },
    }),
  );
}

describe("describeLessonsSwitch", () => {
  it("is off by default: no config, no env", () => {
    expect(describeLessonsSwitch()).toEqual({ enabled: false, source: "default" });
    expect(isLessonsEnabled()).toBe(false);
  });

  it("is on only when lessons.enabled is exactly true", () => {
    writeConfig({ lessons: { enabled: true } });
    expect(describeLessonsSwitch()).toEqual({ enabled: true, source: "config" });
    for (const junk of ["true", 1, "on", "yes", {}]) {
      writeConfig({ lessons: { enabled: junk } });
      expect(describeLessonsSwitch()).toEqual({ enabled: false, source: "default" });
    }
  });

  it("LOOM_LESSONS=off wins over a config that says on", () => {
    writeConfig({ lessons: { enabled: true } });
    for (const name of envNames("LESSONS")) {
      process.env[name] = "off";
      expect(describeLessonsSwitch()).toEqual({ enabled: false, source: "env", via: name });
      expect(isLessonsHardDisabled()).toBe(true);
      delete process.env[name];
    }
  });

  it("an off under one spelling beats an on under another", () => {
    const [a, b] = envNames("LESSONS");
    process.env[a] = "on";
    process.env[b] = "off";
    expect(describeLessonsSwitch()).toEqual({ enabled: false, source: "env", via: b });
  });

  it("LOOM_LESSONS=on stands in for a missing config, and an explicit config false beats it", () => {
    process.env.LOOM_LESSONS = "on";
    expect(describeLessonsSwitch()).toEqual({ enabled: true, source: "env", via: "LOOM_LESSONS" });
    writeConfig({ lessons: { enabled: false } });
    expect(describeLessonsSwitch()).toEqual({ enabled: false, source: "config" });
  });
});

describe("setLessonsEnabled", () => {
  it("writes only lessons.enabled and keeps the rest of the config", () => {
    writeConfig({ testerId: "orbit-007", lessons: { suppress: ["stats/x"] } });
    setLessonsEnabled(true);
    // loadConfig fills in its defaults on the way through, as every writer here does.
    expect(readConfig()).toMatchObject({
      testerId: "orbit-007",
      lessons: { suppress: ["stats/x"], enabled: true },
    });
    setLessonsEnabled(false);
    expect(readConfig().lessons).toEqual({ suppress: ["stats/x"], enabled: false });
  });

  it("turning on puts a latent reporting mode back to off and keeps the acknowledgement", () => {
    writeConfig({ observations: { mode: "auto", autoAcknowledgedAt: "2026-01-01T00:00:00Z" } });
    setLessonsEnabled(true);
    expect(readConfig()).toMatchObject({
      lessons: { enabled: true },
      observations: { mode: "off", autoAcknowledgedAt: "2026-01-01T00:00:00Z" },
    });
    // Turning off leaves the block alone: there is nothing latent to defuse.
    writeConfig({ observations: { mode: "ask" }, lessons: { enabled: true } });
    setLessonsEnabled(false);
    expect(readConfig().observations.mode).toBe("ask");
  });

  it("refuses a config that is not a JSON object", () => {
    fs.writeFileSync(configPath(), "[1, 2]");
    expect(() => setLessonsEnabled(true)).toThrow(/isn't a JSON object/);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("[1, 2]");
  });

  it("refuses to clobber an unparseable config", () => {
    fs.writeFileSync(configPath(), "{ not json");
    expect(() => setLessonsEnabled(true)).toThrow(/couldn't be read/);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("{ not json");
  });

  it("refuses while the env hard-disable is set", () => {
    process.env.LOOM_LESSONS = "off";
    expect(() => setLessonsEnabled(true)).toThrow(/hard-disabled/);
    expect(fs.existsSync(configPath())).toBe(false);
  });
});

describe("every surface is silent while the switch is off", () => {
  const failing = {
    toolName: "mcp__galaxy__run_tool",
    input: { tool_id: "bwa_mem" },
    content: [{ type: "text" as const, text: `Error: ${SIGNATURE} hg38` }],
  };

  it("the store is empty, so the hint, the /execute note and the reproduction index have nothing", async () => {
    plantLesson();
    expect(getLessonStore().lessons).toEqual([]);
    expect(decideHintForEvent(failing, new Set())).toBeNull();
    expect(buildStepLessonNote("align reads with bwa against the build")).toBe("");
    expect(await buildReproductionLessonsContext("reproduce the published RNA-seq analysis")).toBe(
      "",
    );
  });

  it("the same planted lesson hints once the config turns the switch on", () => {
    plantLesson();
    writeConfig({ lessons: { enabled: true } });
    const decision = decideHintForEvent(failing, new Set());
    expect(decision?.match.lesson.id).toBe("galaxy-tools/reference-index-not-registered");
  });

  it("lesson_propose refuses with the pointer, armed or not, and writes nothing", async () => {
    armLessonProposal("explicit", { live: true });
    const ui = {
      hasUI: true,
      ui: { notify: () => {}, select: async () => undefined, confirm: async () => true },
    };
    const outcome = await proposeLesson(
      {
        namespace: "stats",
        slug: "na-coerced-to-zero-in-filters",
        title: "Numeric filters treat NA as zero",
        description: "A significance filter counts NA rows as significant.",
        kind: "pitfall",
        stage: ["result-interpretation"],
        tags: ["awk"],
        stale_after: "2027-09-30",
        cues: "thresholding a p-value column",
        applies_to: { versions: "any", tested: "awk" },
        evidence: {
          symptom: "verified",
          cause: "verified",
          outcome: "validated",
          method: "recount",
        },
        trigger: { tools: ["deseq2"] },
        sections: {
          symptom: "Implausibly many significant genes.",
          cause: "Coercion turns NA into 0.",
          check_first: "Count rows where the tested column is NA.",
          intervention: "Exclude NA explicitly.",
          validate: "State the count among non-NA rows.",
          not_when: "The table has no missing values.",
        },
      },
      ui,
    );
    expect(outcome).toMatchObject({ ok: false, reason: "lessons-off" });
    expect((outcome as { message: string }).message).toContain(LESSONS_OFF_POINTER);
    expect(fs.existsSync(path.join(home, ".loom", "lessons"))).toBe(false);
  });

  it("/lesson refuses every subcommand with the same pointer and sends nothing", async () => {
    const commands = new Map<
      string,
      { handler: (a: string | undefined, c: unknown) => Promise<void> }
    >();
    const sent: string[] = [];
    const notes: { msg: string; level: string }[] = [];
    registerLessonCommand({
      registerCommand: (name: string, def: { handler: never }) => commands.set(name, def),
      sendUserMessage: (text: string) => sent.push(text),
    } as never);
    const ctx = {
      hasUI: true,
      isIdle: () => true,
      ui: { notify: (msg: string, level = "info") => notes.push({ msg, level }) },
    };
    for (const args of [undefined, "list", "drafts", "show stats/x", "save stats/x"]) {
      await commands.get("lesson")!.handler(args, ctx);
    }
    expect(sent).toEqual([]);
    expect(notes).toHaveLength(5);
    for (const n of notes) expect(n).toEqual({ msg: LESSONS_OFF_POINTER, level: "warning" });
  });

  it("the cache does not outlive the switch: an edit to off silences the next read", () => {
    plantLesson();
    writeConfig({ lessons: { enabled: true } });
    expect(getLessonStore().lessons.map((l) => l.id)).toContain(
      "galaxy-tools/reference-index-not-registered",
    );
    writeConfig({ lessons: { enabled: false } });
    expect(getLessonStore().lessons).toEqual([]);
    process.env.LOOM_LESSONS = "on"; // an explicit config false still wins
    expect(getLessonStore().lessons).toEqual([]);
  });

  it("the eval replay seams read nothing, write nothing and arm nothing", async () => {
    fs.writeFileSync(path.join(dir, "lesson-events.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, "proposal.json"), "{}");
    process.env.LOOM_LESSON_REPLAY = "lesson-events.jsonl";
    process.env.LOOM_LESSON_PROPOSAL_REPLAY = "proposal.json";
    const handlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = [];
    const pi = {
      on: (_event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) =>
        handlers.push(handler),
    } as never;
    registerLessonReplay(pi);
    registerLessonProposalReplay(pi);
    const ctx = {
      hasUI: true,
      ui: { notify() {}, select: async () => undefined, confirm: async () => true },
    };
    for (const h of handlers) await h({}, ctx);
    expect(fs.existsSync(path.join(dir, "activity.jsonl"))).toBe(false);
    const { peekLessonProposalArming } = await import("../extensions/loom/lessons/propose");
    expect(peekLessonProposalArming()).toBeNull();
  });

  it("the correction nudge does not fire or arm anything", async () => {
    const sentMessages: unknown[] = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
    registerLessonNudge({
      sendMessage: (message: unknown) => sentMessages.push(message),
      sendUserMessage: () => {},
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) =>
        handlers.set(event, handler),
    } as never);
    await handlers.get("session_start")!({}, { hasUI: true });
    appendActivityEvent(dir, {
      timestamp: new Date().toISOString(),
      kind: "observation.built",
      source: "observation-triggers",
      payload: { kind: "user-correction", trigger: "explicit", stage: "result-interpretation" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sentMessages).toEqual([]);
    const { peekLessonProposalArming } = await import("../extensions/loom/lessons/propose");
    expect(peekLessonProposalArming()).toBeNull();
  });
});
