import { describe, expect, it } from "vitest";
import { planModelDiscovery } from "../app/src/renderer/model-discovery-gate.js";

const SAVED = {
  savedBaseUrl: "https://openrouter.ai/api/v1",
  typedBaseUrl: "https://openrouter.ai/api/v1",
  typedKey: "",
  hadKey: true,
  alreadyDiscovered: false,
};

describe("planModelDiscovery — opening Preferences / switching provider", () => {
  it("probes for a saved custom endpoint with a stored key", () => {
    expect(planModelDiscovery({ ...SAVED, manual: false })).toEqual({ action: "probe" });
  });

  it("skips providers with no saved base URL", () => {
    expect(
      planModelDiscovery({ ...SAVED, manual: false, savedBaseUrl: "", typedBaseUrl: "" }),
    ).toEqual({ action: "skip" });
  });

  it("skips when no key is stored -- there is nothing to probe with", () => {
    expect(planModelDiscovery({ ...SAVED, manual: false, hadKey: false })).toEqual({
      action: "skip",
    });
  });

  it("reuses this session's list instead of re-probing on every provider flip", () => {
    expect(planModelDiscovery({ ...SAVED, manual: false, alreadyDiscovered: true })).toEqual({
      action: "skip",
    });
  });
});

describe("planModelDiscovery — the Fetch models button", () => {
  it("re-probes even when a list was already fetched this session", () => {
    expect(planModelDiscovery({ ...SAVED, manual: true, alreadyDiscovered: true })).toEqual({
      action: "probe",
    });
  });

  it("probes without a stored key so main can explain what's missing", () => {
    expect(planModelDiscovery({ ...SAVED, manual: true, hadKey: false })).toEqual({
      action: "probe",
    });
  });

  it("refuses when nothing is saved yet", () => {
    const plan = planModelDiscovery({
      ...SAVED,
      manual: true,
      savedBaseUrl: "",
      typedBaseUrl: "https://typed.example/v1",
    });
    expect(plan.action).toBe("message");
    if (plan.action === "message") expect(plan.message).toMatch(/save/i);
  });

  // Main probes what's on disk, so fetching against an edited-but-unsaved URL
  // would list a different endpoint's models than the field shows.
  it("refuses when the base URL field no longer matches what was saved", () => {
    const plan = planModelDiscovery({
      ...SAVED,
      manual: true,
      typedBaseUrl: "https://elsewhere.example/v1",
    });
    expect(plan.action).toBe("message");
    if (plan.action === "message") expect(plan.message).toMatch(/base URL/i);
  });

  it("ignores trailing whitespace when comparing the base URL", () => {
    expect(
      planModelDiscovery({
        ...SAVED,
        manual: true,
        typedBaseUrl: "  https://openrouter.ai/api/v1 ",
      }),
    ).toEqual({ action: "probe" });
  });

  it("hands off to the typed-key path when a key is in the field", () => {
    expect(planModelDiscovery({ ...SAVED, manual: true, typedKey: "sk-typed" })).toEqual({
      action: "validate-typed-key",
    });
  });
});
