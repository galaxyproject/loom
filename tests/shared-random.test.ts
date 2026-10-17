import { describe, expect, it } from "vitest";
import { randomBytes, randomHex } from "../shared/random.js";
import { ulid } from "../extensions/loom/ulid";

describe("shared/random", () => {
  it("randomHex is 2n lowercase hex characters and does not repeat", () => {
    const a = randomHex(6);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(randomHex(6)).not.toBe(a);
  });

  it("randomBytes is n bytes", () => {
    const bytes = randomBytes(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(32);
  });

  it("a ULID still comes out as 26 Crockford characters", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
