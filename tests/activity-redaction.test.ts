import { describe, it, expect } from "vitest";
import { redactArgs } from "../extensions/loom/activity-hooks";

describe("redactArgs", () => {
  it("whole-object redacts credential tools", () => {
    expect(redactArgs("galaxy_connect", { url: "x", apiKey: "secret" })).toEqual({
      _redacted: true,
    });
    expect(redactArgs("galaxy_set_profile", { name: "default", apiKey: "k" })).toEqual({
      _redacted: true,
    });
  });

  it("redacts known credential keys on any tool", () => {
    const out = redactArgs("bash", {
      cmd: "echo hi",
      apiKey: "x",
      api_key: "y",
      authorization: "Bearer z",
      token: "t",
      password: "p",
      secret: "s",
      credentials: { foo: "bar" },
    }) as Record<string, unknown>;
    expect(out.cmd).toBe("echo hi");
    expect(out.apiKey).toBe("[redacted]");
    expect(out.api_key).toBe("[redacted]");
    expect(out.authorization).toBe("[redacted]");
    expect(out.token).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect(out.secret).toBe("[redacted]");
    expect(out.credentials).toBe("[redacted]");
  });

  it("redacts credentials in nested objects", () => {
    const out = redactArgs("bash", {
      headers: { Authorization: "Bearer x", "X-Other": "y" },
    }) as Record<string, Record<string, unknown>>;
    expect(out.headers.Authorization).toBe("[redacted]");
    expect(out.headers["X-Other"]).toBe("y");
  });

  it("walks arrays", () => {
    const out = redactArgs("bash", {
      list: [{ token: "a" }, { token: "b" }, "plain"],
    }) as Record<string, Array<Record<string, unknown> | string>>;
    expect(out.list[0]).toEqual({ token: "[redacted]" });
    expect(out.list[1]).toEqual({ token: "[redacted]" });
    expect(out.list[2]).toBe("plain");
  });

  it("passes through primitives and null", () => {
    expect(redactArgs("bash", null)).toBe(null);
    expect(redactArgs("bash", "hello")).toBe("hello");
    expect(redactArgs("bash", 42)).toBe(42);
  });

  it("is case-insensitive on credential key names", () => {
    const out = redactArgs("bash", { ApiKey: "x", AUTHORIZATION: "y" }) as Record<string, unknown>;
    expect(out.ApiKey).toBe("[redacted]");
    expect(out.AUTHORIZATION).toBe("[redacted]");
  });
});
