// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  applyOrbitTheme,
  normalizeOrbitThemePreference,
  resolveAppliedOrbitTheme,
} from "../app/src/renderer/theme.js";

describe("Orbit theme resolution", () => {
  it("defaults missing and invalid values to dark", () => {
    expect(normalizeOrbitThemePreference(undefined)).toBe("dark");
    expect(normalizeOrbitThemePreference("sepia")).toBe("dark");
    expect(normalizeOrbitThemePreference("system")).toBe("dark");
    expect(resolveAppliedOrbitTheme(undefined)).toBe("dark");
  });

  it("applies explicit light and dark", () => {
    expect(resolveAppliedOrbitTheme("light")).toBe("light");
    expect(resolveAppliedOrbitTheme("dark")).toBe("dark");
  });

  it("applies data attributes and color-scheme to the target", () => {
    const target = document.createElement("div");
    const cleanup = applyOrbitTheme("light", target);
    expect(target.dataset.themePreference).toBe("light");
    expect(target.dataset.theme).toBe("light");
    expect(target.style.colorScheme).toBe("light");
    cleanup();
  });
});
