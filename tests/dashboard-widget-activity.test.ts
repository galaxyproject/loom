// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityWidget,
  buildRows,
  formatDetail,
  formatEventDay,
  formatEventTime,
  isAtBottom,
  normalizeBool,
  normalizeKinds,
  normalizeMaxEntries,
  redactForDisplay,
  statusWord,
  summarizeEvent,
  truncate,
  type ActivityConfig,
} from "../app/src/renderer/dashboard/widgets/activity.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import type {
  ActivityEvent,
  DataSource,
  WidgetContext,
} from "../app/src/renderer/dashboard/widget-api.js";

// -- helpers -----------------------------------------------------------------

function event(
  kind: string,
  payload: Record<string, unknown> = {},
  over: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    timestamp: "2026-09-18T10:11:12.000Z",
    kind,
    source: "agent",
    payload,
    ...over,
  };
}

function summaryOf(e: ActivityEvent): string {
  return summarizeEvent(e).text;
}

interface Harness {
  el: HTMLElement;
  header: HTMLElement;
  ctx: WidgetContext<ActivityConfig>;
  sources: DashboardSources;
  setConfig: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  cleanups: Array<() => void>;
  /** Push a snapshot into the activity source the widget is subscribed to. */
  emit(events: ActivityEvent[], available?: boolean): void;
  scroller(): HTMLElement;
  rows(): HTMLElement[];
}

// The widget keeps per-panel state (filter, opened rows, scroll) outside the
// mount so it survives a remount, keyed by panel id -- so each test needs an id
// of its own unless it is deliberately testing that memory.
let panelSeq = 0;

function harness(config: Partial<ActivityConfig> = {}, panelId?: string): Harness {
  const el = document.createElement("div");
  const header = document.createElement("div");
  document.body.append(el, header);
  const sources = new DashboardSources();
  const cleanups: Array<() => void> = [];
  const setConfig = vi.fn();
  const fail = vi.fn();
  const ctx = {
    panelId: panelId ?? `p-activity-${++panelSeq}`,
    config: { ...activityWidget.defaultConfig, ...config },
    sources: sources.sources,
    header,
    setConfig,
    fail,
    onDispose(fn: () => void) {
      cleanups.push(fn);
    },
    subscribe<T>(source: DataSource<T>, listener: (value: T) => void) {
      const off = source.subscribe(listener);
      listener(source.get());
      return off;
    },
  } as WidgetContext<ActivityConfig>;

  // The activity source is fed by a shell file read, which there is no shell
  // for here, so drive its private MutableSource the way the shell would.
  const emit = (events: ActivityEvent[], available = true): void => {
    (sources.sources.activity as unknown as { set(v: unknown): void }).set({
      events,
      available,
      updatedAt: Date.now(),
    });
  };

  return {
    el,
    header,
    ctx,
    sources,
    setConfig,
    fail,
    cleanups,
    emit,
    scroller: () => el.querySelector(".dash-activity-scroll") as HTMLElement,
    rows: () => [...el.querySelectorAll(".dash-activity-row")] as HTMLElement[],
  };
}

function textOf(h: Harness): string {
  return h.el.textContent ?? "";
}

beforeEach(() => {
  document.body.innerHTML = "";
});

/**
 * The jump-to-latest pill carries `dash-panel-btn` from the shared sheet and
 * `dash-activity-jump` from this widget's. Both are one class, so nothing but
 * source order decides which wins, and the widget sheet has to be loaded after
 * the shared one for the pill to keep its surface. Lifting these stylesheets
 * out of TypeScript once got that order wrong and quietly flattened the pill
 * into a plain button, so the order is pinned here rather than trusted.
 *
 * Resolved from the repo root, not from `import.meta.url`: under happy-dom that
 * is an http URL and `fileURLToPath` refuses it.
 */
describe("stylesheet order against the shared dashboard sheet", () => {
  const load = (rel: string): void => {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(process.cwd(), rel), "utf8");
    document.head.append(style);
  };

  it("lets the widget's own rule win on an element that carries both classes", () => {
    document.head.innerHTML = "";
    // The order index.html links them in.
    load("app/src/renderer/dashboard/dashboard.css");
    load("app/src/renderer/dashboard/widgets/activity.css");

    const pill = document.createElement("button");
    pill.className = "dash-panel-btn dash-activity-jump";
    document.body.append(pill);
    const plain = document.createElement("button");
    plain.className = "dash-panel-btn";
    document.body.append(plain);

    expect(getComputedStyle(pill).borderRadius).toBe("10px");
    expect(getComputedStyle(pill).padding).toBe("2px 9px");
    // And the shared button is untouched, so this is a tie-break and not the
    // widget sheet bleeding onto everything.
    expect(getComputedStyle(plain).borderRadius).toBe("4px");
    document.head.innerHTML = "";
  });
});

// -- contract ----------------------------------------------------------------

describe("activity widget contract", () => {
  it("keeps the type and label the registry and the layout document expect", () => {
    expect(activityWidget.type).toBe("activity");
    expect(activityWidget.label).toBe("Analysis log");
    expect(activityWidget.defaultConfig).toEqual({
      kinds: "all",
      maxEntries: 200,
      showDetail: true,
    });
  });
});

// -- one sentence per kind ---------------------------------------------------

describe("summarizeEvent", () => {
  it("names the analysis directory when the session starts", () => {
    const out = summarizeEvent(event("session.started", { cwd: "/home/ann/rnaseq-liver" }));
    expect(out.text).toBe("Opened this analysis in rnaseq-liver");
    expect(out.tone).toBe("info");
  });

  // pi's InputSource is "interactive" | "rpc" | "extension" -- there is no
  // "user", and reading one made every prompt in Orbit (rpc) and in the
  // terminal (interactive) render as though somebody else had sent it.
  it("quotes the prompt back to whoever actually typed it", () => {
    for (const source of ["rpc", "interactive"]) {
      expect(summaryOf(event("user.prompt", { text: "align these reads" }, { source }))).toBe(
        "You asked: align these reads",
      );
    }
  });

  it("does not claim the user typed a prompt the brain sent itself", () => {
    expect(summaryOf(event("user.prompt", { text: "go on" }, { source: "extension" }))).toBe(
      "Loom followed up: go on",
    );
  });

  it("does not guess for a source pi has not shipped yet", () => {
    expect(summaryOf(event("user.prompt", { text: "go on" }, { source: "telepathy" }))).toBe(
      "A prompt arrived: go on",
    );
  });

  it("reads a tool start and a tool end", () => {
    expect(summaryOf(event("tool.start", { toolName: "galaxy_run_workflow" }))).toBe(
      "Started galaxy_run_workflow",
    );
    expect(summarizeEvent(event("tool.end", { toolName: "bash" }))).toEqual({
      text: "Finished bash",
      tone: "ok",
    });
    expect(summarizeEvent(event("tool.end", { toolName: "bash", isError: true }))).toEqual({
      text: "bash failed",
      tone: "failed",
    });
  });

  it("reports a Galaxy transition with its counts, and in the user's words", () => {
    const finished = summarizeEvent(
      event("poll.transition", {
        blockKind: "invocation",
        label: "Variant calling",
        from: "in_progress",
        to: "completed",
        counters: { ok: 11, error: 1, running: 0 },
      }),
    );
    expect(finished.text).toBe('Galaxy workflow run "Variant calling" finished (11 ok, 1 failed)');
    expect(finished.tone).toBe("ok");

    const failed = summarizeEvent(
      event("poll.transition", { blockKind: "job", label: "BWA-MEM2", to: "failed" }),
    );
    expect(failed).toEqual({ text: 'Galaxy job "BWA-MEM2" failed', tone: "failed" });
  });

  it("calls a transitional Galaxy state cancelled, not failed", () => {
    for (const to of ["deleting", "deleted", "stop"]) {
      const out = summarizeEvent(event("poll.transition", { label: "Trim", to }));
      expect(out.text).toBe('Galaxy workflow run "Trim" was cancelled');
      expect(out.tone).not.toBe("failed");
    }
  });

  it("says a run stopped being followed, and what Galaxy last thought of it", () => {
    const out = summarizeEvent(
      event("poll.block_missing", { label: "Trim", galaxyState: "running" }),
    );
    expect(out.text).toBe(
      'Stopped following "Trim" -- its record is gone from the notebook, and Galaxy still says it is running',
    );
    expect(out.tone).toBe("blocked");
  });

  it("distinguishes the four evidence-gate outcomes", () => {
    const base = { completions: ["plan-a-step-2"], contradictions: [{ step: "plan-a-step-2" }] };
    expect(summaryOf(event("evidence.decision", { ...base, outcome: "blocked" }))).toBe(
      'Refused to mark "plan-a-step-2" done -- that Galaxy run did not succeed',
    );
    expect(summaryOf(event("evidence.decision", { ...base, outcome: "warned" }))).toBe(
      'Marked "plan-a-step-2" done even though that Galaxy run did not succeed',
    );
    expect(summaryOf(event("evidence.decision", { ...base, outcome: "overridden" }))).toBe(
      'Marked "plan-a-step-2" done, using the override you granted',
    );
    expect(
      summaryOf(event("evidence.decision", { completions: ["a", "b"], outcome: "recorded" })),
    ).toBe("Marked 2 steps done -- nothing on Galaxy contradicts it");
  });

  it("reads an override back to the person who granted it", () => {
    expect(
      summaryOf(event("evidence.override", { step: "plan-a-step-3" }, { source: "user" })),
    ).toBe('You allowed "plan-a-step-3" to be marked done without Galaxy confirming it');
  });

  it("separates a guard block from a decline, and keeps the human reason", () => {
    expect(
      summaryOf(
        event("guard.decision", {
          toolName: "bash",
          outcome: "blocked",
          reason: "this command deletes files outside the analysis",
        }),
      ),
    ).toBe("Blocked bash -- this command deletes files outside the analysis");
    expect(summaryOf(event("guard.decision", { toolName: "bash", outcome: "blocked:user" }))).toBe(
      "You declined bash",
    );
    expect(summaryOf(event("guard.decision", { toolName: "write", outcome: "allowed" }))).toBe(
      "Allowed write",
    );
    expect(summaryOf(event("guard.decision", { toolName: "write", outcome: "allowed:once" }))).toBe(
      "You approved write",
    );
    expect(
      summaryOf(event("guard.decision", { toolName: "write", outcome: "allowed:session" })),
    ).toBe("Allowed write -- you approved it earlier this session");
  });

  it("does not call a skipped or paused run 'running'", () => {
    const skipped = summarizeEvent(event("poll.transition", { label: "QC", to: "skipped" }));
    expect(skipped).toEqual({ text: 'Galaxy workflow run "QC" was skipped', tone: "info" });
    const paused = summarizeEvent(event("poll.transition", { label: "QC", to: "paused" }));
    expect(paused.tone).toBe("blocked");
    expect(paused.text).toContain("needs you");
  });

  it("returns a sentence rather than throwing when reading the payload throws", () => {
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "text", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const out = summarizeEvent(event("user.prompt", payload, { source: "rpc" }));
    expect(out.text).toBe("user.prompt");
    expect(out.tone).toBe("unknown");
  });

  it("falls back to the raw kind for a kind it has never seen, rather than throwing", () => {
    const out = summarizeEvent(event("galaxy.history_created", { id: "abc" }, { source: "brain" }));
    expect(out).toEqual({ text: "galaxy.history_created (brain)", tone: "unknown" });
  });

  it("survives a payload that is missing, empty, or the wrong type throughout", () => {
    const hostile = [
      { timestamp: "", kind: "", source: "", payload: {} },
      event("tool.end", { toolName: 42, isError: "true" }),
      event("poll.transition", { label: { nope: true }, to: [], counters: "lots" }),
      event("evidence.decision", { completions: "not-a-list", contradictions: 7 }),
      event("guard.decision", { outcome: null }),
      event("session.started", { cwd: 5 }),
      { timestamp: "x", kind: "user.prompt", source: "user" } as unknown as ActivityEvent,
    ];
    for (const e of hostile) {
      expect(() => summarizeEvent(e as ActivityEvent)).not.toThrow();
      expect(typeof summarizeEvent(e as ActivityEvent).text).toBe("string");
    }
  });

  it("caps one entry so a pasted transcript cannot become one enormous row", () => {
    const out = summarizeEvent(event("user.prompt", { text: "x".repeat(5000) }, { source: "rpc" }));
    expect(out.text.length).toBeLessThanOrEqual(201);
  });

  it("flattens newlines and strips bidi overrides, so a row cannot lie about its order", () => {
    const out = summaryOf(
      event("user.prompt", { text: "line one\nline two\u202erm -rf /" }, { source: "rpc" }),
    );
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\u202e");
    expect(out).toContain("line one line two");
  });
});

describe("statusWord", () => {
  it("never shows the machine word for a state it knows", () => {
    expect(statusWord("queued")).toBe("waiting for Galaxy");
    expect(statusWord("in_progress")).toBe("running");
    expect(statusWord("ok")).toBe("finished");
    expect(statusWord("error")).toBe("failed");
    expect(statusWord("deleting")).toBe("cancelled");
    expect(statusWord("paused")).toBe("paused");
  });

  it("passes an unknown state through rather than inventing one", () => {
    expect(statusWord("resubmitted")).toBe("resubmitted");
    expect(statusWord("")).toBe("in a state Galaxy did not name");
  });
});

// -- the credential fence ----------------------------------------------------

/** What the fence writes in place of a value. */
const HIDDEN_MARKER = "[hidden]";

describe("redaction", () => {
  it("hides the value of anything that looks like a credential, at any depth", () => {
    const out = redactForDisplay({
      toolName: "galaxy_connect",
      apiKey: "abc123",
      nested: { AUTHORIZATION: "Bearer xyz", url: "https://usegalaxy.org" },
      list: [{ access_token: "t0ken" }],
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("Bearer xyz");
    expect(text).not.toContain("t0ken");
    // The key names survive: knowing a credential was passed is useful.
    expect(text).toContain("apiKey");
    expect(text).toContain("https://usegalaxy.org");
  });

  it("hides a credential inside the one arg shape the log actually writes", () => {
    // `bash` is not in activity-hooks' NOISY_TOOLS, its args are
    // `{command: "<the whole command line>"}`, and redactArgs there matches key
    // names only -- so `command` is not a credential key and the whole line
    // reached the log. The array fence guards a shape nothing writes; this is
    // the shape everything writes.
    const line = (cmd: string): string => JSON.stringify(redactForDisplay({ command: cmd }));

    expect(line("curl -H 'Authorization: Bearer sk-live-t0ken' https://example.org")).not.toContain(
      "sk-live-t0ken",
    );
    expect(line("curl --api-key abc123xyz https://example.org")).not.toContain("abc123xyz");
    expect(line("export GALAXY_API_KEY=deadbeefcafe && run.sh")).not.toContain("deadbeefcafe");
    // The command is still readable -- the reader can see what ran.
    expect(line("curl --api-key abc123xyz https://example.org")).toContain("https://example.org");
    expect(line("export GALAXY_API_KEY=deadbeefcafe && run.sh")).toContain("GALAXY_API_KEY");
  });

  it("leaves an ordinary command and an ordinary listing completely alone", () => {
    // The regression this fence has already had once: matching a credential
    // stem against any bare word blanked `results.csv` because `monkey.png`
    // came before it. Every string below contains a stem (`key` in monkey and
    // keygen, `session` in session1) and none of them is a credential.
    const same = (value: unknown): void => expect(redactForDisplay(value)).toEqual(value);

    same({ command: "ls -la results/ && head -5 monkey.png results.csv" });
    same({ command: "python keygen.py --out session1.dat" });
    same({ outputs: ["monkey.png", "results.csv"] });
    same({ files: ["session1", "session2", "session3"] });
    // Prose is not a command line: a colon with nothing after it must not
    // reach across the space and blank the next word.
    same({ text: "Authorization: failed, retrying against the staging server" });
  });

  it("cuts a cycle instead of blowing the stack", () => {
    const payload: Record<string, unknown> = { name: "loop" };
    payload.self = payload;
    expect(() => JSON.stringify(redactForDisplay(payload))).not.toThrow();
    expect(JSON.stringify(redactForDisplay(payload))).toContain("[circular]");
  });

  it("stops at a depth and a breadth, so a deep or wide payload cannot run away", () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 50; i++) deep = { down: deep };
    expect(() => JSON.stringify(redactForDisplay(deep))).not.toThrow();

    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) wide[`k${i}`] = i;
    const out = redactForDisplay(wide) as Record<string, unknown>;
    expect(Object.keys(out).length).toBeLessThanOrEqual(41);
  });

  it("bounds a shared subtree, which cutting a cycle does not", () => {
    // The cycle guard is a path set, so a node reachable by N paths used to be
    // materialised N times. Seven distinct objects, six deep, twenty wide: no
    // cycle anywhere, and the old code spent twenty seconds on it before
    // JSON.stringify threw.
    let level: Record<string, unknown> = { leaf: true };
    for (let d = 0; d < 6; d++) {
      const wide: Record<string, unknown> = {};
      for (let i = 0; i < 20; i++) wide[`k${i}`] = level;
      level = wide;
    }
    // Generous on purpose. The unbounded version takes thirteen seconds here
    // and the bounded one takes under a millisecond, so the gap is four orders
    // of magnitude and the budget only has to sit inside it -- a tight one
    // would turn this into a test of how busy the machine is.
    const started = Date.now();
    const out = redactForDisplay(level);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("treats a __proto__ key as data, not as a prototype", () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}, "normal": 1}');
    const out = redactForDisplay(payload) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    // And the key is still shown, rather than silently vanishing from the record.
    expect(JSON.stringify(out)).toContain("__proto__");
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("hides a key called credentials, which the stems alone would miss", () => {
    const out = redactForDisplay({ credentials: "user:pass" });
    expect(JSON.stringify(out)).not.toContain("user:pass");
  });

  it("covers the abbreviations a payload actually spells", () => {
    const out = redactForDisplay({
      auth: "Basic abc",
      bearer: "b3ar3r",
      cred: "cr3d",
      pwd: "pw0rd",
      passwd: "pa55wd",
      cookie: "c00kie",
      sessionId: "s3ss10n",
      signature: "s1gnature",
      "x-amz-security-token": "s3curity",
    });
    const text = JSON.stringify(out);
    for (const leaked of [
      "Basic abc",
      "b3ar3r",
      "cr3d",
      "pw0rd",
      "pa55wd",
      "c00kie",
      "s3ss10n",
      "s1gnature",
      "s3curity",
    ]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it("hides what a credential flag introduces in a command recorded as a token list", () => {
    // An array element has no key for the fence to read, so a command line
    // recorded as argv used to carry the key that the same command recorded as
    // a string would have lost.
    const out = redactForDisplay({
      argv: ["galaxy-cli", "--api-key", "sup3rs3cret", "upload", "reads.fq"],
      curl: ["curl", "-H", "Authorization: Bearer t0kenv4lue", "https://usegalaxy.org"],
      inline: ["--token=t0keninline"],
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("sup3rs3cret");
    expect(text).not.toContain("t0kenv4lue");
    expect(text).not.toContain("t0keninline");
    // Whatever the name introduces, of whatever type.
    const structured = redactForDisplay({ args: ["--secret", { value: "n3sted" }] });
    expect(JSON.stringify(structured)).not.toContain("n3sted");
    // The shape of the command still reads, which is the point of showing it.
    expect(text).toContain("--api-key");
    expect(text).toContain("upload");
    expect(text).toContain("reads.fq");
    expect(text).toContain("https://usegalaxy.org");
  });

  it("does not blank a value because a sentence next to it mentions a key", () => {
    const out = redactForDisplay({
      notes: ["the api key rotated last week", "reads.fq", "https://host:8080/galaxy"],
    });
    const text = JSON.stringify(out);
    expect(text).toContain("reads.fq");
    expect(text).toContain("https://host:8080/galaxy");
  });

  it("does not blank a file because the one before it is called monkey.png", () => {
    // The whole failure mode of a name-shaped heuristic: an ordinary list of
    // results is not a command line, and a stem match with no leading dash
    // fires on `monkey`, `session1.dat`, `donkey_genome.fa` and `keygen.py`.
    // Losing a filename with no way to work out why is worse than the leak.
    const out = redactForDisplay({
      outputs: ["monkey.png", "results.csv", "summary.tsv"],
      datasets: ["donkey_genome.fa", "reads.fastq"],
      files: ["session1.dat", "session2.dat", "session3.dat", "session4.dat"],
      argv: ["python", "keygen.py", "out.txt"],
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(HIDDEN_MARKER);
    for (const kept of [
      "results.csv",
      "summary.tsv",
      "reads.fastq",
      "session2.dat",
      "session4.dat",
      "out.txt",
    ]) {
      expect(text, kept).toContain(kept);
    }
  });

  it("hides the element a bare header name introduces, rather than claiming to", () => {
    // `Authorization:` as its own element carries no value, so writing
    // "[hidden]" into it hides nothing and prints the real value next door.
    const out = redactForDisplay({
      argv: ["curl", "-H", "Authorization:", "Bearer t0kenv4lue", "https://usegalaxy.org"],
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("t0kenv4lue");
    expect(text).toContain("Authorization:");
    expect(text).toContain("https://usegalaxy.org");
  });

  it("caps a key, because a payload can use a whole value as one", () => {
    const out = redactForDisplay({ ["z".repeat(500)]: 1 }) as Record<string, unknown>;
    const [key] = Object.keys(out);
    expect(key.length).toBeLessThanOrEqual(81);
  });

  it("caps a huge string", () => {
    expect(truncate("x".repeat(2_000_000), 400).length).toBe(401);
  });

  it("carries values JSON cannot, rather than throwing on them", () => {
    const out = redactForDisplay({ big: BigInt(7), nan: NaN, fn: () => 1 }) as Record<
      string,
      unknown
    >;
    expect(out.big).toBe("7");
    expect(out.nan).toBe("NaN");
    expect(out.fn).toBeUndefined();
  });

  it("puts the kind and source in the detail block and caps the whole thing", () => {
    const detail = formatDetail(event("tool.end", { resultSummary: "y".repeat(9000) }));
    expect(detail).toContain("kind: tool.end");
    expect(detail).toContain("source: agent");
    expect(detail.length).toBeLessThanOrEqual(2001);
  });
});

// -- config coercion ---------------------------------------------------------

describe("config coercion", () => {
  it("clamps maxEntries and ignores what is not a number", () => {
    expect(normalizeMaxEntries(25)).toBe(25);
    expect(normalizeMaxEntries(0)).toBe(1);
    expect(normalizeMaxEntries(-5)).toBe(1);
    expect(normalizeMaxEntries(1e9)).toBe(500);
    expect(normalizeMaxEntries("banana")).toBe(200);
    expect(normalizeMaxEntries(undefined)).toBe(200);
    expect(normalizeMaxEntries(12.7)).toBe(12);
    expect(normalizeMaxEntries("50")).toBe(50);
  });

  // Every one of these is a finite 0 through `Number()`, which the clamp would
  // turn into a one-row panel. `"maxEntries": null` is ordinary model output.
  it("does not read null, an empty string or a boolean as zero", () => {
    for (const value of [null, "", "   ", false, true, [], {}]) {
      expect(normalizeMaxEntries(value)).toBe(200);
    }
  });

  it("treats an unusable or empty kinds list as no filter at all", () => {
    expect(normalizeKinds("all")).toBeNull();
    expect(normalizeKinds([])).toBeNull();
    expect(normalizeKinds([1, null])).toBeNull();
    expect(normalizeKinds(["tool.end", 3, "user.prompt"])).toEqual(
      new Set(["tool.end", "user.prompt"]),
    );
  });

  it("reads a boolean written as a string and falls back otherwise", () => {
    expect(normalizeBool(false, true)).toBe(false);
    expect(normalizeBool("false", true)).toBe(false);
    expect(normalizeBool("true", false)).toBe(true);
    expect(normalizeBool("maybe", true)).toBe(true);
  });
});

// -- rows --------------------------------------------------------------------

describe("buildRows", () => {
  const events = [
    event("user.prompt", { text: "align these reads" }, { source: "rpc" }),
    event("tool.start", { toolName: "bash" }),
    event("tool.end", { toolName: "bash" }),
  ];

  it("keeps the log in the order it happened, newest last", () => {
    const rows = buildRows(events, { kinds: "all", maxEntries: 10, showDetail: true });
    expect(rows.map((r) => r.text)).toEqual([
      "You asked: align these reads",
      "Started bash",
      "Finished bash",
    ]);
  });

  it("drops kinds the config did not ask for", () => {
    const rows = buildRows(events, { kinds: ["tool.end"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("Finished bash");
  });

  it("matches the text filter against the sentence, the kind and the source", () => {
    expect(buildRows(events, {}, "align")).toHaveLength(1);
    expect(buildRows(events, {}, "tool.")).toHaveLength(2);
    expect(buildRows(events, {}, "USER")).toHaveLength(1);
    expect(buildRows(events, {}, "nothing here")).toHaveLength(0);
  });

  it("keeps the newest maxEntries rows, not the oldest", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      event(
        "tool.end",
        { toolName: `t${i}` },
        { timestamp: `2026-09-18T10:00:${String(i % 60).padStart(2, "0")}.000Z` },
      ),
    );
    const rows = buildRows(many, { maxEntries: 5 });
    expect(rows).toHaveLength(5);
    expect(rows[4].text).toBe("Finished t39");
  });

  it("keeps a key stable when an older twin falls out of the tail", () => {
    // Same millisecond, same kind, same source: only the payload tells them
    // apart, so without a discriminator the survivor is renumbered onto the
    // departed row's key and inherits whatever the user had opened.
    const older = event("tool.start", { toolCallId: "c1", toolName: "a" });
    const newer = event("tool.start", { toolCallId: "c2", toolName: "b" });
    const before = buildRows([older, newer], {});
    const after = buildRows([newer], {});
    expect(after[0].key).toBe(before[1].key);
    expect(before[0].key).not.toBe(before[1].key);
  });

  it("gives two events in the same second distinct keys", () => {
    const twice = [
      event("tool.start", { toolName: "bash" }),
      event("tool.start", { toolName: "bash" }),
    ];
    const rows = buildRows(twice, {});
    expect(rows[0].key).not.toBe(rows[1].key);
  });

  it("keeps a row's key stable when a filter hides the rows around it", () => {
    const all = buildRows(events, {});
    const filtered = buildRows(events, {}, "Finished");
    expect(filtered[0].key).toBe(all[2].key);
  });

  it("labels the first visible row with its day and then only on a change", () => {
    const across = [
      event("tool.end", { toolName: "a" }, { timestamp: "2026-09-17T09:00:00.000Z" }),
      event("tool.end", { toolName: "b" }, { timestamp: "2026-09-17T09:00:01.000Z" }),
      event("tool.end", { toolName: "c" }, { timestamp: "2026-09-18T09:00:00.000Z" }),
    ];
    const days = buildRows(across, {}).map((r) => r.day);
    expect(days[0]).not.toBeNull();
    expect(days[1]).toBeNull();
    expect(days[2]).not.toBeNull();
    expect(days[2]).not.toBe(days[0]);
  });

  it("does not serialise the detail of rows the cap is about to throw away", () => {
    let serialised = 0;
    const many = Array.from({ length: 50 }, (_, i) => {
      const payload: Record<string, unknown> = {};
      Object.defineProperty(payload, "toolName", {
        enumerable: true,
        get() {
          serialised++;
          return `t${i}`;
        },
      });
      return event("tool.end", payload);
    });
    const rows = buildRows(many, { maxEntries: 3 });
    expect(rows).toHaveLength(3);
    // Three details formatted, plus one summary read per event to filter on.
    expect(serialised).toBeLessThan(60);
  });

  it("leaves the detail out entirely when the panel is configured without it", () => {
    expect(buildRows(events, { showDetail: false }).every((r) => r.detail === "")).toBe(true);
    expect(buildRows(events, { showDetail: true }).every((r) => r.detail.length > 0)).toBe(true);
  });
});

// -- the auto-scroll decision ------------------------------------------------

describe("isAtBottom", () => {
  it("follows while the view is at or near the bottom", () => {
    expect(isAtBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(isAtBottom({ scrollTop: 880, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it("stops following once the user has scrolled up", () => {
    expect(isAtBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it("follows a view too short to scroll, and a panel with no height yet", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 300 })).toBe(true);
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true);
  });

  it("follows rather than stalling when the measurements are not numbers", () => {
    expect(isAtBottom({ scrollTop: NaN, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it("honours a caller-supplied threshold", () => {
    expect(isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 100 }, 200)).toBe(true);
    expect(isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 100 }, 10)).toBe(false);
  });
});

describe("time formatting", () => {
  it("renders a wall-clock time and a day label", () => {
    const iso = "2026-09-18T10:11:12.000Z";
    const local = new Date(iso);
    const pad = (n: number): string => String(n).padStart(2, "0");
    expect(formatEventTime(iso)).toBe(
      `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`,
    );
    expect(formatEventDay(iso)).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
  });

  it("says so rather than rendering Invalid Date", () => {
    expect(formatEventTime("not a time")).toBe("--:--:--");
    expect(formatEventTime("")).toBe("--:--:--");
    expect(formatEventDay("not a time")).toBeNull();
  });
});

describe("truncate", () => {
  it("does not split a surrogate pair", () => {
    const out = truncate("ab\u{1F600}cd", 3);
    expect(out).toBe("ab\u{1F600}…");
  });

  it("still caps a string made entirely of astral characters", () => {
    // Two code units each, so a code-unit shortcut would read this as already
    // short enough and hand the whole thing back.
    const out = truncate("\u{1F600}".repeat(500), 400);
    expect(Array.from(out)).toHaveLength(401);
  });

  it("returns a string that is already within the cap untouched", () => {
    const mixed = "\u{1F600}".repeat(20) + "x".repeat(380);
    expect(Array.from(mixed)).toHaveLength(400);
    expect(truncate(mixed, 400)).toBe(mixed);
  });
});

// -- mounted behaviour -------------------------------------------------------

describe("mounted activity widget", () => {
  it("does not claim the window cannot read a log that simply does not exist yet", () => {
    // `available: false` is what a brand-new analysis looks like -- the read
    // returned "no such file" -- in the same window whose File pane is reading
    // files perfectly well, so naming a missing capability was wrong on the
    // common path. The panel says what is true of every case it cannot tell
    // apart, and still says where the log is being written.
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([], false);
    expect(textOf(h)).toContain("Nothing to show from the analysis log yet");
    expect(textOf(h)).toContain("either nothing has been written, or this window cannot read it");
    expect(textOf(h)).toContain("activity.jsonl");
    expect(textOf(h)).not.toContain("not readable in this window");
    expect(h.rows()).toHaveLength(0);
  });

  it("invites the user to wait when the log exists but is empty", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([]);
    expect(textOf(h)).toContain("Nothing yet.");
  });

  it("draws a row per event and updates when the log grows", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.start", { toolName: "bash" })]);
    expect(h.rows()).toHaveLength(1);
    h.emit([event("tool.start", { toolName: "bash" }), event("tool.end", { toolName: "bash" })]);
    expect(h.rows()).toHaveLength(2);
    expect(textOf(h)).toContain("Finished bash");
  });

  it("never turns a payload into markup", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([
      event(
        "user.prompt",
        { text: '<img src=x onerror="alert(1)"><b>bold</b>' },
        { source: "rpc" },
      ),
    ]);
    expect(h.el.querySelector("img")).toBeNull();
    expect(h.el.querySelector("b")).toBeNull();
    expect(textOf(h)).toContain("<b>bold</b>");
  });

  it("never renders a credential value, in the row or in its detail", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([
      event("tool.start", {
        toolName: "galaxy_connect",
        args: { url: "https://usegalaxy.org", api_key: "SUPERSECRET" },
      }),
    ]);
    expect(h.el.innerHTML).not.toContain("SUPERSECRET");
    expect(textOf(h)).toContain("api_key");
    expect(textOf(h)).toContain("[hidden]");
  });

  it("keeps the DOM under the configured cap", () => {
    const h = harness({ maxEntries: 5 });
    activityWidget.mount(h.el, h.ctx);
    h.emit(Array.from({ length: 60 }, (_, i) => event("tool.end", { toolName: `t${i}` })));
    expect(h.rows()).toHaveLength(5);
    expect(textOf(h)).toContain("Showing 5 of 60 entries.");
  });

  it("filters from the header without asking the host to persist anything", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([
      event("user.prompt", { text: "align these reads" }, { source: "rpc" }),
      event("tool.end", { toolName: "bash" }),
    ]);
    const filter = h.header.querySelector("input") as HTMLInputElement;
    filter.value = "align";
    filter.dispatchEvent(new Event("input"));
    expect(h.rows()).toHaveLength(1);
    expect(textOf(h)).toContain("align these reads");
    expect(h.setConfig).not.toHaveBeenCalled();
  });

  it("says so when the filter matches nothing", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    const filter = h.header.querySelector("input") as HTMLInputElement;
    filter.value = "zzzz";
    filter.dispatchEvent(new Event("input"));
    expect(textOf(h)).toContain("matches that filter");
  });

  it("persists the detail toggle, because that one is a panel setting", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    const buttons = [...h.header.querySelectorAll("button")];
    const detail = buttons.find((b) => b.textContent === "detail") as HTMLButtonElement;
    expect(detail.getAttribute("aria-pressed")).toBe("true");
    detail.click();
    expect(h.setConfig).toHaveBeenCalledWith({ showDetail: false });
  });

  it("reads a boolean a document wrote as a string the same way the rows do", () => {
    const h = harness({ showDetail: "false" as unknown as boolean });
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    const detail = [...h.header.querySelectorAll("button")].find(
      (b) => b.textContent === "detail",
    ) as HTMLButtonElement;
    expect(h.el.querySelector("details")).toBeNull();
    expect(detail.getAttribute("aria-pressed")).toBe("false");
    detail.click();
    expect(h.setConfig).toHaveBeenCalledWith({ showDetail: true });
  });

  it("draws plain rows with no disclosure when detail is off", () => {
    const h = harness({ showDetail: false });
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    expect(h.el.querySelector("details")).toBeNull();
    expect(h.el.querySelector(".dash-activity-row-plain")).not.toBeNull();
  });

  it("leaves an entry the user opened open when the next event arrives", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    const first = event("tool.start", { toolName: "bash" });
    h.emit([first]);
    const details = h.el.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    h.emit([first, event("tool.end", { toolName: "bash" })]);
    const after = [...h.el.querySelectorAll("details")] as HTMLDetailsElement[];
    expect(after).toHaveLength(2);
    expect(after[0].open).toBe(true);
    expect(after[1].open).toBe(false);
  });

  it("offers a way back to the newest entry once the user scrolls up", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    const scroller = h.scroller();
    const jump = h.el.querySelector(".dash-activity-jump") as HTMLButtonElement;
    expect(jump.hidden).toBe(true);

    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true });
    scroller.scrollTop = 200;
    scroller.dispatchEvent(new Event("scroll"));
    expect(jump.hidden).toBe(false);

    jump.click();
    expect(jump.hidden).toBe(true);
    expect(scroller.scrollTop).toBe(1000);
  });

  it("stops following while the user is reading further up", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "a" })]);
    const scroller = h.scroller();
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true });
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));

    scroller.scrollTop = 0;
    h.emit([event("tool.end", { toolName: "a" }), event("tool.end", { toolName: "b" })]);
    expect(scroller.scrollTop).toBe(0);
  });

  it("empties its element and stops listening when it is disposed", () => {
    const h = harness();
    const dispose = activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    const scroller = h.scroller();
    const jump = h.el.querySelector(".dash-activity-jump") as HTMLButtonElement;
    for (const fn of h.cleanups) fn();
    dispose?.();

    expect(h.el.textContent).toBe("");
    expect(h.el.classList.contains("dash-activity")).toBe(false);
    // The scroll listener is registered through ctx.onDispose, so running the
    // cleanups must have taken it off: a scroll now changes nothing.
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true });
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    expect(jump.hidden).toBe(true);
  });

  it("draws a divider the day the log crosses one, and not otherwise", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([
      event("tool.end", { toolName: "a" }, { timestamp: "2026-09-17T09:00:00.000Z" }),
      event("tool.end", { toolName: "b" }, { timestamp: "2026-09-17T09:00:01.000Z" }),
      event("tool.end", { toolName: "c" }, { timestamp: "2026-09-18T09:00:00.000Z" }),
    ]);
    const days = [...h.el.querySelectorAll(".dash-activity-day")].map((d) => d.textContent);
    expect(days).toHaveLength(2);
    expect(days[0]).not.toBe(days[1]);
  });

  it("says the log went away if the shell stops being able to read it", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    expect(h.rows()).toHaveLength(1);
    h.emit([], false);
    expect(h.rows()).toHaveLength(0);
    expect(textOf(h)).toContain("Nothing to show from the analysis log yet");
  });

  it("never asks the host to fail the panel over a hostile log", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    h.emit([
      event("who.knows", cyclic, { timestamp: "nonsense", source: "" }),
      event("tool.end", { toolName: "\u202eevil" }),
    ]);
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.rows()).toHaveLength(2);
    expect(textOf(h)).toContain("--:--:--");
  });

  it("puts the reader back where they were when the log grows under them", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "a" })]);
    const scroller = h.scroller();
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true });

    // A real browser clamps scrollTop to 0 when the list is emptied and the
    // scroll height collapses; happy-dom does not, so asserting on the value
    // afterwards would pass with no restore at all. Watch for the write.
    let top = 0;
    const writes: number[] = [];
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
        writes.push(v);
      },
    });
    scroller.scrollTop = 250;
    scroller.dispatchEvent(new Event("scroll"));
    writes.length = 0;

    h.emit([event("tool.end", { toolName: "a" }), event("tool.end", { toolName: "b" })]);
    expect(writes).toContain(250);
    expect(scroller.scrollTop).toBe(250);
  });

  it("carries the filter, the opened rows and the reading position across a remount", () => {
    const events = [
      event("user.prompt", { text: "align these reads" }, { source: "rpc" }),
      event("tool.end", { toolName: "bash" }),
    ];
    const first = harness({}, "p-shared");
    activityWidget.mount(first.el, first.ctx);
    first.emit(events);
    const filter = first.header.querySelector("input") as HTMLInputElement;
    filter.value = "align";
    filter.dispatchEvent(new Event("input"));
    const opened = first.el.querySelector("details") as HTMLDetailsElement;
    opened.open = true;
    opened.dispatchEvent(new Event("toggle"));
    expect(first.rows()).toHaveLength(1);

    // What a click on the detail toggle does: setConfig, whole dashboard
    // re-render, every widget remounted onto a fresh element.
    for (const fn of first.cleanups) fn();
    const second = harness({}, "p-shared");
    activityWidget.mount(second.el, second.ctx);
    second.emit(events);

    expect((second.header.querySelector("input") as HTMLInputElement).value).toBe("align");
    expect(second.rows()).toHaveLength(1);
    expect((second.el.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("takes the jump button away when the panel grows enough to show everything", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "a" })]);
    const scroller = h.scroller();
    const jump = h.el.querySelector(".dash-activity-jump") as HTMLButtonElement;
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true });
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    expect(jump.hidden).toBe(false);

    // The panel is now tall enough for the whole list. No scroll event will
    // arrive to say so, so the redraw has to work it out for itself.
    Object.defineProperty(scroller, "clientHeight", { value: 1000, configurable: true });
    h.emit([event("tool.end", { toolName: "a" }), event("tool.end", { toolName: "b" })]);
    expect(jump.hidden).toBe(true);
  });

  it("keeps the count of what it is hiding out of the scrolling list", () => {
    const h = harness({ maxEntries: 2 });
    activityWidget.mount(h.el, h.ctx);
    h.emit(Array.from({ length: 6 }, (_, i) => event("tool.end", { toolName: `t${i}` })));
    const trim = h.el.querySelector(".dash-activity-trim") as HTMLElement;
    expect(trim.hidden).toBe(false);
    expect(trim.textContent).toBe("Showing 2 of 6 entries.");
    expect(h.el.querySelector(".dash-activity-scroll")?.contains(trim)).toBe(false);
  });

  it("does not also count what it is hiding when nothing matches at all", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    const filter = h.header.querySelector("input") as HTMLInputElement;
    filter.value = "zzzz";
    filter.dispatchEvent(new Event("input"));
    expect((h.el.querySelector(".dash-activity-trim") as HTMLElement).hidden).toBe(true);
  });
});
