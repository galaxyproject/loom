import { describe, expect, it } from "vitest";
import { formatWindowTitle } from "../app/src/main/window-title.js";

describe("formatWindowTitle", () => {
  it("home-abbreviates a cwd under the home directory", () => {
    expect(formatWindowTitle("/Users/dannon/work/projectA", "/Users/dannon")).toBe(
      "~/work/projectA — Orbit",
    );
  });

  it("renders the home directory itself as ~", () => {
    expect(formatWindowTitle("/Users/dannon", "/Users/dannon")).toBe("~ — Orbit");
  });

  it("leaves a cwd outside the home directory unabbreviated", () => {
    expect(formatWindowTitle("/srv/data/projectB", "/Users/dannon")).toBe(
      "/srv/data/projectB — Orbit",
    );
  });

  it("does not abbreviate a sibling dir that merely shares the home prefix", () => {
    // "/Users/dannonsextra" starts with "/Users/dannon" as a string but is not
    // inside it -- abbreviating here would be wrong.
    expect(formatWindowTitle("/Users/dannonsextra/x", "/Users/dannon")).toBe(
      "/Users/dannonsextra/x — Orbit",
    );
  });

  it("normalizes a trailing separator on the cwd", () => {
    expect(formatWindowTitle("/Users/dannon/", "/Users/dannon")).toBe("~ — Orbit");
  });

  it("normalizes a trailing separator on the home dir", () => {
    expect(formatWindowTitle("/Users/dannon/work", "/Users/dannon/")).toBe("~/work — Orbit");
  });

  it("abbreviates when home is the filesystem root", () => {
    expect(formatWindowTitle("/srv/data", "/")).toBe("~/srv/data — Orbit");
  });

  it("abbreviates with the original separator (Windows-style paths)", () => {
    // The helper must not key off the runner's path.sep -- a backslash path
    // abbreviates on any OS, and the backslash separator is preserved.
    expect(
      formatWindowTitle("C:\\Users\\dannon\\work\\projectA", "C:\\Users\\dannon"),
    ).toBe("~\\work\\projectA — Orbit");
  });

  it("falls back to bare Orbit when no cwd is set", () => {
    expect(formatWindowTitle("", "/Users/dannon")).toBe("Orbit");
  });
});
