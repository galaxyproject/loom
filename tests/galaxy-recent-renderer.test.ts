// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentGalaxyPanel } from "../app/src/renderer/galaxy-recent";
import type { GalaxyActivitySnapshot } from "../shared/loom-shell-contract.js";

const data: GalaxyActivitySnapshot = {
  phase: "ready",
  server: "https://galaxy.example/subpath",
  histories: [
    {
      id: "bbd44e69cb8906b579031c61c5da0079",
      name: "<img src=x onerror=alert(1)>",
      count: 9,
      published: true,
      updatedAt: "2026-09-21T12:00:00",
    },
  ],
  invocations: [
    {
      id: "d426ce413085bb90",
      name: "Variant calling",
      historyId: "bbd44e69cb8906b579031c61c5da0079",
      historyName: "Test history",
      state: "scheduled",
      createdAt: "2026-09-21T12:00:00",
      updatedAt: "2026-09-21T12:10:00",
    },
  ],
};
function setup() {
  document.body.innerHTML = '<section id="recent"></section>';
  const root = document.querySelector<HTMLElement>("#recent")!;
  const api = {
    refreshGalaxyActivity: vi.fn(async () => {}),
    openGalaxyActivity: vi.fn(async () => ({ opened: true })),
  };
  const panel = new RecentGalaxyPanel(root, api);
  panel.update(data);
  return { root, panel, api };
}
afterEach(() => vi.useRealTimers());
describe("recent Galaxy renderer", () => {
  it("escapes server names, preserves scheduled, and opens links through the bridge", () => {
    const { root, api, panel } = setup();
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    root.querySelector<HTMLAnchorElement>("a")!.click();
    expect(api.openGalaxyActivity).toHaveBeenCalledWith(
      expect.stringContaining("/subpath/histories/view?id="),
    );
    root.querySelector<HTMLButtonElement>('[data-view="invocations"]')!.click();
    expect(root.querySelector(".run-state")!.textContent).toBe("Scheduled");
    expect(root.querySelector(".run-state.completed")).toBeNull();
    panel.reset();
  });
  it("filters lists and labels stale data without discarding it", () => {
    const { root, panel } = setup();
    panel.update({ ...data, historiesError: "Offline", phase: "error" });
    expect(root.querySelector(".recent-notice")!.textContent).toContain("last-known data");
    expect(root.querySelectorAll(".history-row")).toHaveLength(1);
    const input = root.querySelector("input")!;
    input.value = "no match";
    input.dispatchEvent(new Event("input"));
    expect(root.querySelectorAll(".history-row")).toHaveLength(0);
    panel.update({ server: null, phase: "disconnected", histories: [], invocations: [] });
    expect(root.textContent).toContain("Connect to Galaxy");
    panel.reset();
  });
  it("releases a missing refresh response without leaving the control disabled", async () => {
    vi.useFakeTimers();
    const { root, panel } = setup();
    await panel.refresh();
    expect(root.querySelector<HTMLButtonElement>(".recent-refresh")!.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(root.querySelector<HTMLButtonElement>(".recent-refresh")!.disabled).toBe(false);
    expect(root.textContent).toContain("No response from Loom");
    panel.reset();
  });
});
