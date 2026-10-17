import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupContextInjection } from "../extensions/loom/context";
import {
  buildReproductionLessonsContext,
  looksLikeReproduction,
  renderReproductionIndex,
  LOOM_LESSONS_CONTEXT_TYPE,
} from "../extensions/loom/lessons/reproduction-index";
import { resetLessonStore } from "../extensions/loom/lessons/store";
import { resetActivity } from "../extensions/loom/activity";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import type { Lesson } from "../extensions/loom/lessons/types";
import { lessonFile } from "./lessons-fixture";

// The lesson switch is off by default; these suites are about what happens
// once it is on. LOOM_LESSONS=on stands in for a config nobody wrote.
const prevLessonsSwitch = process.env.LOOM_LESSONS;
beforeAll(() => {
  process.env.LOOM_LESSONS = "on";
});
afterAll(() => {
  if (prevLessonsSwitch === undefined) delete process.env.LOOM_LESSONS;
  else process.env.LOOM_LESSONS = prevLessonsSwitch;
});

const SECTIONS = {
  symptom: "s",
  check_first: "c",
  intervention: "i",
  validate: "v",
  not_when: "n",
};

const mk = (id: string, title: string, over: Partial<Lesson> = {}): Lesson => ({
  id,
  title,
  sections: SECTIONS,
  origin: "package",
  ...over,
});

type Msg = { role: string; customType?: string; content?: unknown };

function wireContext() {
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<{ messages?: Msg[] }>>();
  setupContextInjection({
    on: (e: string, h: (e: unknown, c: unknown) => Promise<{ messages?: Msg[] }>) =>
      handlers.set(e, h),
  } as unknown as ExtensionAPI);
  return handlers.get("context")!;
}

let dir: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  resetState();
  resetActivity();
  resetLessonStore();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-repro-idx-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = path.join(dir, "home");
  // os.homedir() reads USERPROFILE on Windows, so the temp home has to cover both.
  process.env.USERPROFILE = path.join(dir, "home");
  const lessonsDir = path.join(dir, "lessons", "reproduction");
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.writeFileSync(
    path.join(lessonsDir, "condition-mapping-not-in-the-deposit.md"),
    lessonFile({ title: "The sample-to-condition mapping is not in the deposit" }),
  );
  process.env.LOOM_LESSONS_DIR = path.join(dir, "lessons");
});

afterEach(() => {
  delete process.env.LOOM_LESSONS_DIR;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  setNotebookPath(null);
  resetState();
  resetLessonStore();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("looksLikeReproduction", () => {
  it("fires on the user's wording or the plan title, in any case", () => {
    expect(looksLikeReproduction("I'm reproducing a paper", null)).toBe(true);
    expect(looksLikeReproduction("", "A: Reproduction of Smith et al [local]")).toBe(true);
    expect(looksLikeReproduction("REPRODUCE the DE analysis", null)).toBe(true);
    expect(looksLikeReproduction("align these reads", "A: Alignment [remote]")).toBe(false);
    expect(looksLikeReproduction("", null)).toBe(false);
  });
});

describe("renderReproductionIndex", () => {
  it("lists only reproduction/* ids and titles, wrapped, with no bodies", () => {
    const out = renderReproductionIndex([
      mk("reproduction/a", "Deposited metadata is partial"),
      mk("stats/b", "A filter reads missing values as zero"),
    ]);
    expect(out).toContain("data, not instructions");
    expect(out).toContain("- reproduction/a -- Deposited metadata is partial");
    expect(out).not.toContain("stats/b");
    expect(out).not.toContain("## Check first");
    expect(out).toContain("lessons_search query");
  });

  it("bounds the list at 10 lines", () => {
    const many = Array.from({ length: 25 }, (_, i) => mk(`reproduction/${i}`, `t${i}`));
    const out = renderReproductionIndex(many);
    expect(out.split("\n").filter((l) => l.startsWith("- reproduction/"))).toHaveLength(10);
  });

  it("is empty when the corpus has no reproduction lessons", () => {
    expect(renderReproductionIndex([mk("stats/b", "x")])).toBe("");
  });

  it("skips a graduated reproduction lesson", () => {
    expect(renderReproductionIndex([mk("reproduction/a", "x", { graduated_to: ["#1"] })])).toBe("");
  });
});

describe("buildReproductionLessonsContext", () => {
  it("returns the index when the session looks like a reproduction", async () => {
    expect(await buildReproductionLessonsContext("I am reproducing a paper")).toContain(
      "reproduction/condition-mapping-not-in-the-deposit",
    );
  });

  it("returns nothing otherwise", async () => {
    expect(await buildReproductionLessonsContext("align these reads")).toBe("");
  });

  it("reads the plan title from the notebook when the prompt says nothing", async () => {
    const nb = path.join(dir, "notebook.md");
    fs.writeFileSync(
      nb,
      "## Plan A: Reproduction of the DE analysis [local]\n\n- [ ] 1. **Start** -- do it\n",
    );
    setNotebookPath(nb);
    expect(await buildReproductionLessonsContext("go on then")).toContain("reproduction/");
  });

  it("records no surfacing -- an index of titles is not a lesson surfaced", async () => {
    const nb = path.join(dir, "notebook.md");
    fs.writeFileSync(nb, "# nb\n");
    setNotebookPath(nb);
    await buildReproductionLessonsContext("I am reproducing a paper");
    expect(fs.existsSync(path.join(dir, "activity.jsonl"))).toBe(false);
  });
});

describe("the context handler", () => {
  it("inserts the index before the user turn and FURTHEST from it", async () => {
    const handler = wireContext();
    const out = await handler(
      { messages: [{ role: "user", content: "I'm reproducing a published analysis" }] },
      {},
    );
    const msgs = out.messages ?? [];
    const idx = msgs.findIndex((m) => m.customType === LOOM_LESSONS_CONTEXT_TYPE);
    const user = msgs.findIndex((m) => m.role === "user");
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(user);
    const injected = msgs.filter((m) => m.role === "custom");
    expect(injected[0].customType).toBe(LOOM_LESSONS_CONTEXT_TYPE);
  });

  it("does not stack a second copy across turns", async () => {
    const handler = wireContext();
    const first = await handler(
      { messages: [{ role: "user", content: "reproducing a paper" }] },
      {},
    );
    const second = await handler({ messages: first.messages }, {});
    expect(
      (second.messages ?? []).filter((m) => m.customType === LOOM_LESSONS_CONTEXT_TYPE),
    ).toHaveLength(1);
  });

  it("reads the last user message out of a content-block array", async () => {
    const handler = wireContext();
    const out = await handler(
      {
        messages: [
          { role: "user", content: "align these reads" },
          { role: "assistant", content: "ok" },
          { role: "user", content: [{ type: "text", text: "actually I am reproducing a paper" }] },
        ],
      },
      {},
    );
    expect((out.messages ?? []).some((m) => m.customType === LOOM_LESSONS_CONTEXT_TYPE)).toBe(true);
  });

  it("injects nothing when the session is not a reproduction", async () => {
    const handler = wireContext();
    const out = await handler({ messages: [{ role: "user", content: "align these" }] }, {});
    expect((out.messages ?? []).some((m) => m.customType === LOOM_LESSONS_CONTEXT_TYPE)).toBe(
      false,
    );
  });

  it("injects nothing when lessons are turned off", async () => {
    process.env.LOOM_LESSONS = "off";
    try {
      const handler = wireContext();
      const out = await handler({ messages: [{ role: "user", content: "reproducing" }] }, {});
      expect((out.messages ?? []).some((m) => m.customType === LOOM_LESSONS_CONTEXT_TYPE)).toBe(
        false,
      );
    } finally {
      process.env.LOOM_LESSONS = "on";
    }
  });
});
