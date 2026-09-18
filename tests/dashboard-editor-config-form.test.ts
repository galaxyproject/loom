import { describe, expect, it } from "vitest";
import {
  applyFieldValue,
  describeConfigFields,
  formatConfigJson,
  humanizeKey,
  parseConfigJson,
  unsupportedConfigKeys,
} from "../app/src/renderer/dashboard/editor/config-form.js";

describe("humanizeKey", () => {
  it("turns a widget author's key into something a reader can use", () => {
    expect(humanizeKey("follow")).toBe("Follow");
    expect(humanizeKey("maxRows")).toBe("Max rows");
    expect(humanizeKey("tail_lines")).toBe("Tail lines");
    expect(humanizeKey("show-failed-only")).toBe("Show failed only");
    expect(humanizeKey("")).toBe("");
  });
});

describe("describeConfigFields", () => {
  it("makes a control for every primitive the widget declared, in its order", () => {
    const fields = describeConfigFields(
      { follow: true, limit: 20, label: "recent" },
      { follow: false, limit: 5, label: "all" },
    );
    expect(fields).toEqual([
      { key: "follow", label: "Follow", kind: "boolean", value: false },
      { key: "limit", label: "Limit", kind: "number", value: 5 },
      { key: "label", label: "Label", kind: "string", value: "all" },
    ]);
  });

  it("falls back to the default when the panel has no value, or the wrong kind of one", () => {
    const fields = describeConfigFields(
      { follow: true, limit: 20 },
      { limit: "not a number" as unknown as number },
    );
    expect(fields.map((f) => f.value)).toEqual([true, 20]);
  });

  it("skips a default the form cannot represent", () => {
    const fields = describeConfigFields(
      { nested: { a: 1 }, list: [1, 2], nothing: null, missing: undefined, ok: true },
      {},
    );
    expect(fields.map((f) => f.key)).toEqual(["ok"]);
  });

  it("skips a non-finite numeric default rather than drawing NaN in a box", () => {
    expect(describeConfigFields({ n: Number.NaN }, {})).toEqual([]);
  });

  it("copes with a widget that declares no config at all", () => {
    expect(describeConfigFields({}, { stray: 1 })).toEqual([]);
  });
});

describe("unsupportedConfigKeys", () => {
  it("names what only the JSON editor can reach", () => {
    expect(
      unsupportedConfigKeys(
        { follow: true, nested: { a: 1 } },
        { follow: false, nested: { a: 2 }, extra: 3 },
      ),
    ).toEqual(["nested", "extra"]);
  });

  it("is empty when the generated form covers everything", () => {
    expect(unsupportedConfigKeys({ follow: true }, { follow: false })).toEqual([]);
  });
});

describe("parseConfigJson", () => {
  it("accepts an object and treats empty text as no settings", () => {
    expect(parseConfigJson('{"follow": false}')).toEqual({ ok: true, config: { follow: false } });
    expect(parseConfigJson("   ")).toEqual({ ok: true, config: {} });
  });

  it("explains a syntax error rather than throwing", () => {
    const result = parseConfigJson("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  it("refuses anything that is not a JSON object", () => {
    for (const text of ["[1,2]", "null", '"hello"', "42", "true"]) {
      const result = parseConfigJson(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("JSON object");
    }
  });
});

describe("applyFieldValue and formatConfigJson", () => {
  it("sets one key without disturbing the rest", () => {
    expect(applyFieldValue({ a: 1, b: 2 }, "b", 9)).toEqual({ a: 1, b: 9 });
  });

  it("does not mutate the config it was given", () => {
    const config = { a: 1 };
    applyFieldValue(config, "a", 2);
    expect(config).toEqual({ a: 1 });
  });

  it("formats readably, and never throws on something JSON cannot carry", () => {
    expect(formatConfigJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatConfigJson(circular)).toBe("{}");
  });
});
