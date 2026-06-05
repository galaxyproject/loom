import { describe, it, expect } from "vitest";
import { shouldEnableAutoUpdate } from "../app/src/main/auto-update-policy.js";

describe("shouldEnableAutoUpdate", () => {
  it("enables only on packaged darwin with checks on", () => {
    expect(
      shouldEnableAutoUpdate({ platform: "darwin", isPackaged: true, updateCheck: true }),
    ).toBe(true);
  });
  it("is off in dev (unpackaged)", () => {
    expect(
      shouldEnableAutoUpdate({ platform: "darwin", isPackaged: false, updateCheck: true }),
    ).toBe(false);
  });
  it("is off on non-darwin (Linux uses the notify-link banner)", () => {
    expect(shouldEnableAutoUpdate({ platform: "linux", isPackaged: true, updateCheck: true })).toBe(
      false,
    );
  });
  it("is off when the user opted out", () => {
    expect(
      shouldEnableAutoUpdate({ platform: "darwin", isPackaged: true, updateCheck: false }),
    ).toBe(false);
  });
});
