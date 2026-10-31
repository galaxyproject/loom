import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CATALOG_SEARCHES } from "./hints";

/** The tools a plain launch's first request offers, as surface.test pins them. */
const offered = new Set(
  (
    JSON.parse(readFileSync(join(__dirname, "__surface__", "request-plain.json"), "utf8")) as {
      tools: Array<{ function: { name: string } }>;
    }
  ).tools.map((t) => t.function.name),
);

describe("Olit's rules against the tool surface", () => {
  it("keys the catalog-miss note on searches the agent still offers", () => {
    expect([...CATALOG_SEARCHES].filter((name) => !offered.has(name))).toEqual([]);
  });
});
