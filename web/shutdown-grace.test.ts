import { describe, it, expect } from "vitest";
import { resolveShutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS } from "./shutdown-grace.js";

describe("resolveShutdownGraceMs", () => {
  it("defaults when unset", () => {
    expect(resolveShutdownGraceMs({})).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
  });
  it("honors a numeric override", () => {
    expect(resolveShutdownGraceMs({ LOOM_SHUTDOWN_GRACE_MS: "2500" })).toBe(2500);
  });
  it("allows 0 (kill immediately) as an explicit choice", () => {
    expect(resolveShutdownGraceMs({ LOOM_SHUTDOWN_GRACE_MS: "0" })).toBe(0);
  });
  // setTimeout(NaN) fires immediately, so a garbage override would turn the
  // SIGKILL backstop into an instant kill and drop the notebook flush.
  it("falls back on a non-numeric override", () => {
    expect(resolveShutdownGraceMs({ LOOM_SHUTDOWN_GRACE_MS: "soon" })).toBe(
      DEFAULT_SHUTDOWN_GRACE_MS,
    );
  });
  it("falls back on an empty override", () => {
    expect(resolveShutdownGraceMs({ LOOM_SHUTDOWN_GRACE_MS: "" })).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
  });
  it("falls back on a negative override", () => {
    expect(resolveShutdownGraceMs({ LOOM_SHUTDOWN_GRACE_MS: "-1" })).toBe(
      DEFAULT_SHUTDOWN_GRACE_MS,
    );
  });
});
