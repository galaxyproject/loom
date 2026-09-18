// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDashboard } from "../app/src/renderer/dashboard/bootstrap.js";
import {
  createDefaultDashboardDocument,
  serializeDashboardDocument,
} from "../shared/dashboard-contract.js";

interface FakeShell {
  loadDashboard?: ReturnType<typeof vi.fn>;
  saveDashboard?: ReturnType<typeof vi.fn>;
  readFile?: ReturnType<typeof vi.fn>;
  listFiles?: ReturnType<typeof vi.fn>;
}

let root: HTMLElement;

function installShell(shell: FakeShell): void {
  (window as unknown as Record<string, unknown>).orbit = shell;
}

/** Let the load promise chain settle without advancing the save debounce. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = "<div id='dash'></div>";
  root = document.getElementById("dash")!;
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).orbit;
});

describe("first run", () => {
  it("renders the default layout and says nothing when there is no file", async () => {
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: null, revision: null }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    expect(dash.host.getDocument()).toEqual(createDefaultDashboardDocument());
    expect(root.querySelector(".dash-banner")?.classList.contains("hidden")).toBe(true);
    expect(shell.saveDashboard).not.toHaveBeenCalled();
  });

  it("treats an empty file the same as no file", async () => {
    installShell({
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: "   ", revision: "r0" }),
      saveDashboard: vi.fn(),
    });
    const dash = initDashboard(root);
    await settle();
    expect(dash.host.getDocument()).toEqual(createDefaultDashboardDocument());
    expect(root.querySelector(".dash-banner")?.classList.contains("hidden")).toBe(true);
  });
});

describe("loading a saved layout", () => {
  it("adopts it without writing it straight back", async () => {
    const saved = {
      version: 1,
      activeId: "mine",
      dashboards: [
        {
          id: "mine",
          title: "Mine",
          panels: [{ id: "p", widget: "jobs", config: {}, layout: { span: 2 as const, rows: 4 } }],
        },
      ],
    };
    const shell: FakeShell = {
      loadDashboard: vi
        .fn()
        .mockResolvedValue({ ok: true, raw: JSON.stringify(saved), revision: "rS" }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    expect(dash.host.getActiveDashboard()?.id).toBe("mine");
    vi.advanceTimersByTime(1000);
    expect(shell.saveDashboard).not.toHaveBeenCalled();
  });

  it("falls back to the default and leaves a corrupt file alone", async () => {
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: "{ not json", revision: "rBad" }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    const banner = root.querySelector(".dash-banner") as HTMLElement;
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.textContent).toContain("could not be read");
    expect(dash.host.getDocument()).toEqual(createDefaultDashboardDocument());
    vi.advanceTimersByTime(1000);
    expect(shell.saveDashboard).not.toHaveBeenCalled();
  });

  it("refuses a document from a newer build the same way", async () => {
    installShell({
      loadDashboard: vi.fn().mockResolvedValue({
        ok: true,
        raw: '{"version":99,"activeId":"x","dashboards":[]}',
        revision: "rNew",
      }),
      saveDashboard: vi.fn(),
    });
    initDashboard(root);
    await settle();
    expect(root.querySelector(".dash-banner")?.classList.contains("hidden")).toBe(false);
  });

  it("reports a shell-side read error in the banner", async () => {
    installShell({
      loadDashboard: vi.fn().mockResolvedValue({ ok: false, error: "EACCES" }),
      saveDashboard: vi.fn(),
    });
    initDashboard(root);
    await settle();
    expect(root.querySelector(".dash-banner")?.textContent).toContain("EACCES");
  });
});

describe("compare and swap", () => {
  it("hands the revision it loaded back on the save based on it", async () => {
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: null, revision: null }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true, revision: "r1" }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    const first = dash.host.getDocument();
    first.dashboards[0].title = "One";
    dash.host.setDocument(first);
    vi.advanceTimersByTime(400);
    await settle();
    expect(shell.saveDashboard!.mock.calls[0][1]).toBeNull();

    const second = dash.host.getDocument();
    second.dashboards[0].title = "Two";
    dash.host.setDocument(second);
    vi.advanceTimersByTime(400);
    await settle();
    // The revision the first save returned is the base for the second.
    expect(shell.saveDashboard!.mock.calls[1][1]).toBe("r1");
    dash.stop();
  });

  it("takes the newer layout and says so when a save conflicts", async () => {
    const theirs = JSON.stringify({
      version: 1,
      activeId: "theirs",
      dashboards: [{ id: "theirs", title: "Written by the agent", panels: [] }],
    });
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: null, revision: null }),
      saveDashboard: vi.fn().mockResolvedValue({
        ok: false,
        conflict: true,
        error: "changed",
        raw: theirs,
        revision: "r9",
      }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    const mine = dash.host.getDocument();
    mine.dashboards[0].title = "Mine";
    dash.host.setDocument(mine);
    vi.advanceTimersByTime(400);
    await settle();

    expect(dash.host.getActiveDashboard()?.id).toBe("theirs");
    expect(root.querySelector(".dash-banner")?.textContent).toContain("changed elsewhere");
    dash.stop();
  });

  it("picks up a layout something else rewrote, without being asked to save", async () => {
    const theirs = JSON.stringify({
      version: 1,
      activeId: "theirs",
      dashboards: [{ id: "theirs", title: "Theirs", panels: [] }],
    });
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, raw: null, revision: null })
      .mockResolvedValue({ ok: true, raw: theirs, revision: "r2" });
    installShell({ loadDashboard, saveDashboard: vi.fn() });
    const dash = initDashboard(root);
    await settle();
    expect(dash.host.getActiveDashboard()?.id).toBe("current-analysis");

    dash.refreshFromFiles();
    await settle();
    expect(dash.host.getActiveDashboard()?.id).toBe("theirs");
    dash.stop();
  });

  it("polls for an external change even where the shell has no file watcher", async () => {
    const theirs = JSON.stringify({
      version: 1,
      activeId: "theirs",
      dashboards: [{ id: "theirs", title: "Theirs", panels: [] }],
    });
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, raw: null, revision: null })
      .mockResolvedValue({ ok: true, raw: theirs, revision: "r2" });
    installShell({ loadDashboard, saveDashboard: vi.fn() });
    const dash = initDashboard(root);
    await settle();

    vi.advanceTimersByTime(6000);
    await settle();
    expect(dash.host.getActiveDashboard()?.id).toBe("theirs");
    dash.stop();
  });

  it("puts the default back when the file is deleted out from under it", async () => {
    // What `/dashboard undo` does when the change it is undoing is the one that
    // created the file. Taking the revision alone left the removed layout on
    // screen, and since the revision had moved nothing asked again -- so the
    // next edit wrote the deleted layout back out.
    const theirs = JSON.stringify({
      version: 1,
      activeId: "theirs",
      dashboards: [{ id: "theirs", title: "Theirs", panels: [] }],
    });
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, raw: theirs, revision: "r2" })
      .mockResolvedValue({ ok: true, raw: null, revision: null });
    installShell({ loadDashboard, saveDashboard: vi.fn() });
    const dash = initDashboard(root);
    await settle();
    expect(dash.host.getActiveDashboard()?.id).toBe("theirs");

    vi.advanceTimersByTime(6000);
    await settle();
    expect(dash.host.getActiveDashboard()?.id).toBe("current-analysis");
    dash.stop();
  });

  it("keeps the layout when the file is present but empty", async () => {
    // A zero-byte file is a write someone is in the middle of, or a truncation
    // -- not a deletion. Treating it as one would throw away the layout on
    // screen for a blip, which is the data loss this whole pass is about.
    const theirs = JSON.stringify({
      version: 1,
      activeId: "theirs",
      dashboards: [{ id: "theirs", title: "Theirs", panels: [] }],
    });
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, raw: theirs, revision: "r2" })
      .mockResolvedValue({ ok: true, raw: "   ", revision: "r3" });
    installShell({ loadDashboard, saveDashboard: vi.fn() });
    const dash = initDashboard(root);
    await settle();
    expect(dash.host.getActiveDashboard()?.id).toBe("theirs");

    vi.advanceTimersByTime(6000);
    await settle();
    expect(dash.host.getActiveDashboard()?.id).toBe("theirs");
    dash.stop();
  });

  it("does not let the poll overwrite a change the user just made", async () => {
    const theirs = JSON.stringify({
      version: 1,
      activeId: "theirs",
      dashboards: [{ id: "theirs", title: "Theirs", panels: [] }],
    });
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, raw: null, revision: null })
      .mockResolvedValue({ ok: true, raw: theirs, revision: "r2" });
    installShell({ loadDashboard, saveDashboard: vi.fn().mockResolvedValue({ ok: true }) });
    const dash = initDashboard(root);
    await settle();

    const mine = dash.host.getDocument();
    mine.dashboards[0].title = "Mine";
    dash.host.setDocument(mine);
    // The poll fires while the save is still queued.
    vi.advanceTimersByTime(200);
    await settle();
    expect(dash.host.getActiveDashboard()?.title).toBe("Mine");
    dash.stop();
  });
});

describe("saving", () => {
  it("writes the serialized document after the debounce, once", async () => {
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: null, revision: null }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    const first = dash.host.getDocument();
    first.dashboards[0].title = "Renamed";
    dash.host.setDocument(first);
    const second = dash.host.getDocument();
    second.dashboards[0].title = "Renamed twice";
    dash.host.setDocument(second);

    expect(shell.saveDashboard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(shell.saveDashboard).toHaveBeenCalledTimes(1);
    const written = shell.saveDashboard!.mock.calls[0][0] as string;
    expect(written).toBe(serializeDashboardDocument(dash.host.getDocument()));
    expect(JSON.parse(written).dashboards[0].title).toBe("Renamed twice");
  });

  it("drops a queued save when the analysis directory changes under it", async () => {
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: null, revision: null }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    const changed = dash.host.getDocument();
    changed.dashboards[0].title = "Belongs to the old workspace";
    dash.host.setDocument(changed);

    dash.reloadForCwd();
    vi.advanceTimersByTime(1000);
    await settle();

    expect(shell.saveDashboard).not.toHaveBeenCalled();
  });

  it("goes back to the default layout when the new directory has none", async () => {
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: null, revision: null }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    const changed = dash.host.getDocument();
    changed.dashboards[0].title = "Old workspace";
    dash.host.setDocument(changed, { persist: false });

    dash.reloadForCwd();
    await settle();
    expect(dash.host.getDocument()).toEqual(createDefaultDashboardDocument());
  });
});

describe("a shell with no dashboard channels", () => {
  it("still renders, and does not blow up trying to save", async () => {
    installShell({});
    const dash = initDashboard(root);
    await settle();

    expect(root.querySelectorAll(".dash-panel").length).toBeGreaterThan(0);
    const next = dash.host.getDocument();
    next.dashboards[0].title = "Whatever";
    expect(() => dash.host.setDocument(next)).not.toThrow();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });

  it("survives a load that rejects", async () => {
    installShell({ loadDashboard: vi.fn().mockRejectedValue(new Error("socket gone")) });
    expect(() => initDashboard(root)).not.toThrow();
    await settle();
    expect(root.querySelectorAll(".dash-panel").length).toBeGreaterThan(0);
  });
});

describe("a layout file that will not parse", () => {
  it("lets the next deliberate change replace it, as the banner promises", async () => {
    // `adopt` advanced the revision only on a successful parse, so an
    // unreadable file left it at null forever: every later save went out
    // against a revision the file never had, the compare-and-swap refused it,
    // the conflict branch re-adopted the same corrupt text and it never
    // converged. The user rearranged their dashboard, was told nothing, and
    // lost it on reload -- under a banner saying "changing anything here will
    // replace it".
    const corrupt = '{"version":1,"activeId":"current-analysis","dashboards":[{"id":"current-ana';
    const saveDashboard = vi.fn(async () => ({ ok: true as const, revision: "r-new" }));
    installShell({
      loadDashboard: vi.fn(async () => ({
        ok: true as const,
        raw: corrupt,
        revision: "r-corrupt",
      })),
      saveDashboard,
    });
    const dash = initDashboard(root);
    await settle();

    dash.host.setDocument(createDefaultDashboardDocument());
    await vi.advanceTimersByTimeAsync(400);

    expect(saveDashboard).toHaveBeenCalledTimes(1);
    // The revision it carries is the corrupt file's, so the swap matches and
    // the write lands instead of conflicting forever.
    expect(saveDashboard.mock.calls[0][1]).toBe("r-corrupt");
    await settle();
    // And the banner goes: it was promising to replace a file it has now
    // replaced. Seen stale on screen in the web shell before this.
    expect(root.querySelector(".dash-banner")?.classList.contains("hidden")).toBe(true);
    dash.stop();
  });
});

describe("a save that was queued behind one that conflicted", () => {
  it("is dropped rather than written under the revision we just adopted", async () => {
    // Edit A goes out, edit B queues behind it, A comes back conflicted. B was
    // built on the revision A lost, so writing it now would stamp it with the
    // revision being adopted and quietly overwrite the external edit the user
    // was just told about.
    const theirs = serializeDashboardDocument(createDefaultDashboardDocument());
    let releaseFirst: (v: unknown) => void = () => {};
    const first = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const saveDashboard = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ ok: true, revision: "r-mine" });
    installShell({
      loadDashboard: vi.fn(async () => ({ ok: true as const, raw: null, revision: null })),
      saveDashboard,
    });
    const dash = initDashboard(root);
    await settle();

    dash.host.setDocument(createDefaultDashboardDocument());
    await vi.advanceTimersByTimeAsync(400);
    expect(saveDashboard).toHaveBeenCalledTimes(1);

    // Edit B, queued while A is still in flight.
    dash.host.setDocument(createDefaultDashboardDocument());

    releaseFirst({
      ok: false,
      conflict: true,
      error: "changed on disk",
      raw: theirs,
      revision: "r-theirs",
    });
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    await settle();

    // B never went out: it was based on a revision that no longer exists.
    expect(saveDashboard).toHaveBeenCalledTimes(1);
    dash.stop();
  });
});
