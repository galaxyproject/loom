import { describe, it, expect } from "vitest";
import {
  normalizeSignature,
  SIGNATURE_MAX,
  UNKNOWN_SIGNATURE,
} from "../shared/observation-contract.js";

// One row per normalization rule, plus the interactions that bit when the rules
// were applied in C1's originally-listed order (paths before URLs carved a URL
// into `https:<path>`).
const NORMALIZATION_TABLE: Array<[string, string, string]> = [
  ["first line only", "boom\nat frame 2\nat frame 3", "boom"],
  ["CRLF first line", "boom\r\nat frame 2", "boom"],
  ["collapses whitespace", "  too   many \t spaces  ", "too many spaces"],
  ["url", "see https://usegalaxy.org/datasets/abc?x=1 now", "see <url> now"],
  ["email", "mail alice.researcher@institute.edu please", "mail <email> please"],
  ["posix path", "wrote /Users/alice/analyses/run.log ok", "wrote <path> ok"],
  ["tilde path", "from ~/bin/galaxy-cli", "from <path>"],
  ["windows path", "open C:\\Users\\bob\\run.log", "open <path>"],
  ["single slash is not a path", "pass and/or fail", "pass and/or fail"],
  ["16 hex", "dataset 2a56fb8e4c1d9f70 missing", "dataset <id> missing"],
  ["32 hex", "id 2a56fb8e4c1d9f70b3ac55e1d2f80911 x", "id <id> x"],
  ["15 hex is left alone", "code 2a56fb8e4c1d9f7 x", "code 2a56fb8e4c1d9f7 x"],
  ["5+ digit int", "history 1203847 gone", "history <n> gone"],
  ["4 digit int survives the int rule", "exit 4096 raised", "exit 4096 raised"],
  // Left alone on purpose -- the validator rejects both shapes instead, which
  // drops the observation rather than reshaping it.
  [
    "short hid phrase is left for the validator",
    "dataset 42 is in error",
    "dataset 42 is in error",
  ],
  ["hid phrase with punctuation is left alone", "hid=7 unavailable", "hid=7 unavailable"],
  ["non-ascii is left for the validator", "bad\u00e9\u00e9 input", "bad\u00e9\u00e9 input"],
  ["url wins over the path inside it", "GET https://h/Users/a/b failed", "GET <url> failed"],
];

describe("normalizeSignature", () => {
  for (const [label, input, expected] of NORMALIZATION_TABLE) {
    it(label, () => expect(normalizeSignature(input)).toBe(expected));
  }

  it("truncates to the cap with no ellipsis character", () => {
    const out = normalizeSignature("x".repeat(400));
    expect(out).toHaveLength(SIGNATURE_MAX);
    expect(out).toBe("x".repeat(SIGNATURE_MAX));
  });

  it("returns the unknown literal rather than an empty signature", () => {
    for (const input of [undefined, null, "", "   ", "\n\n", "/Users/alice/"]) {
      expect(normalizeSignature(input), JSON.stringify(input)).not.toBe("");
    }
    expect(normalizeSignature(undefined)).toBe(UNKNOWN_SIGNATURE);
    expect(normalizeSignature("")).toBe(UNKNOWN_SIGNATURE);
    expect(normalizeSignature("   ")).toBe(UNKNOWN_SIGNATURE);
    expect(normalizeSignature(12345)).toBe("<n>");
  });

  it("applies the five replacements in the locked order", () => {
    // Paths before URLs used to turn this into `https:<path>`, which then
    // slipped past the validator's https?:// check with the host still gone but
    // the scheme left behind. URL first is why this is one placeholder.
    expect(normalizeSignature("GET https://host/a/b?x=1 failed")).toBe("GET <url> failed");
    // An email inside a path: email first. The path class excludes < and >,
    // so the placeholder splits it into two path runs -- ugly, but nothing of
    // the original survives.
    expect(normalizeSignature("stat /home/alice@x.com/f/g")).toBe("stat <path><email><path>");
    // A hex id inside a path never survives as an id, because the path went first.
    expect(normalizeSignature("read /tmp/2a56fb8e4c1d9f70/x")).toBe("read <path>");
  });

  it("scrubs a whole hostile line", () => {
    const hostile =
      "ToolExecutionError: dataset 2a56fb8e4c1d9f70b3ac55e1d2f80911 in history 1203847 " +
      "failed; wrote /Users/alice/analyses/patient-07/run.log; " +
      "see https://usegalaxy.org/datasets/2a56fb8e4c1d9f70b3ac55e1d2f80911; " +
      "mail alice.researcher@institute.edu";
    expect(normalizeSignature(hostile)).toBe(
      "ToolExecutionError: dataset <id> in history <n> failed; wrote <path> see <url> mail <email>",
    );
  });
});

import {
  validateObservation,
  scanObservationForLeaks,
  capObservation,
  observationByteLength,
  OBSERVATION_MAX_BYTES,
  textLeaks,
  PUBLIC_GALAXY_SERVERS,
} from "../shared/observation-contract.js";

const valid = {
  schemaVersion: 1 as const,
  id: "550e8400-e29b-41d4-a716-446655440000",
  clientTs: "2026-09-30T12:00:00.000Z",
  client: { app: "loom-cli" as const, version: "0.8.0", platform: "darwin" as const },
  installToken: "a".repeat(32),
  kind: "tool-error" as const,
  stage: "tool-parameterization" as const,
  trigger: "tool_error" as const,
  tools: [{ id: "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2", version: "2.2.1+galaxy1" }],
  mcpTool: "galaxy_run_tool",
  datatypes: ["fastqsanger.gz"],
  signature: "ToolExecutionError: dataset <id> in history <n> failed",
  galaxy: { server: "usegalaxy.org" },
  description: "A paired-end input was rejected because one mate was in an error state.",
};

function errs(patch: Record<string, unknown>): string[] {
  const res = validateObservation({ ...valid, ...patch });
  return res.ok ? [] : res.errors;
}

describe("validateObservation", () => {
  it("accepts a well-formed observation", () => {
    expect(validateObservation(valid)).toEqual({ ok: true });
  });

  it("accepts an empty description", () => {
    expect(validateObservation({ ...valid, description: "" })).toEqual({ ok: true });
  });

  it("rejects a non-object", () => {
    expect(validateObservation(null).ok).toBe(false);
    expect(validateObservation([]).ok).toBe(false);
    expect(validateObservation("nope").ok).toBe(false);
  });

  it("rejects unknown keys at every level", () => {
    expect(errs({ extra: 1 })).toContain("extra:unknown-key");
    expect(errs({ client: { ...valid.client, hostname: "box" } })).toContain(
      "client.hostname:unknown-key",
    );
    expect(errs({ galaxy: { server: "usegalaxy.org", url: "x" } })).toContain(
      "galaxy.url:unknown-key",
    );
    expect(errs({ tools: [{ id: "x", owner: "alice" }] })).toContain("tools[0].owner:unknown-key");
  });

  it("names an odd-shaped unknown key as <unknown>, never by its value", () => {
    expect(errs({ "alice@institute.edu": 1 })).toContain("<unknown>:unknown-key");
    expect(errs({ ["x".repeat(41)]: 1 })).toContain("<unknown>:unknown-key");
    expect(errs({ client: { ...valid.client, "/Users/alice": 1 } })).toContain(
      "client.<unknown>:unknown-key",
    );
    expect(JSON.stringify(errs({ "alice@institute.edu": 1 }))).not.toContain("alice");
  });

  it("rejects a wrong schemaVersion", () => {
    expect(errs({ schemaVersion: 2 })).toContain("schemaVersion:unsupported");
  });

  it("rejects an id that is not a v4 uuid", () => {
    expect(errs({ id: "not-a-uuid" })).toContain("id:not-a-uuid-v4");
    // v1 uuid: version nibble is 1, not 4.
    expect(errs({ id: "550e8400-e29b-11d4-a716-446655440000" })).toContain("id:not-a-uuid-v4");
  });

  it("rejects a non-ISO clientTs", () => {
    expect(errs({ clientTs: "2026-09-30 12:00:00" })).toContain("clientTs:not-iso-8601");
  });

  it("rejects an unknown app, platform or non-boolean wsl", () => {
    expect(errs({ client: { ...valid.client, app: "cli" } })).toContain("client.app:not-allowed");
    expect(errs({ client: { ...valid.client, platform: "aix" } })).toContain(
      "client.platform:not-allowed",
    );
    expect(errs({ client: { ...valid.client, wsl: "yes" } })).toContain("client.wsl:not-a-boolean");
    expect(errs({ client: { ...valid.client, version: "" } })).toContain(
      "client.version:bad-length",
    );
  });

  it("rejects an installToken that is not 32 lowercase hex", () => {
    expect(errs({ installToken: "A".repeat(32) })).toContain("installToken:not-32-hex");
    expect(errs({ installToken: "a".repeat(31) })).toContain("installToken:not-32-hex");
  });

  it("rejects unknown enum values", () => {
    expect(errs({ kind: "weird" })).toContain("kind:not-allowed");
    expect(errs({ stage: "weird" })).toContain("stage:not-allowed");
    expect(errs({ trigger: "weird" })).toContain("trigger:not-allowed");
  });

  it("enforces the tool caps", () => {
    expect(errs({ tools: Array(6).fill({ id: "x" }) })).toContain("tools:too-many");
    expect(errs({ tools: [{ id: "" }] })).toContain("tools[0].id:bad-length");
    expect(errs({ tools: [{ id: "x".repeat(201) }] })).toContain("tools[0].id:bad-length");
    expect(errs({ tools: [{ id: "x", version: "v".repeat(41) }] })).toContain(
      "tools[0].version:bad-length",
    );
    expect(errs({ tools: "nope" })).toContain("tools:not-an-array");
  });

  it("enforces the mcpTool and datatype caps", () => {
    expect(errs({ mcpTool: "x".repeat(81) })).toContain("mcpTool:bad-length");
    expect(errs({ datatypes: Array(6).fill("bed") })).toContain("datatypes:too-many");
    expect(errs({ datatypes: ["x".repeat(41)] })).toContain("datatypes[0]:bad-length");
    expect(errs({ datatypes: "bed" })).toContain("datatypes:not-an-array");
  });

  it("enforces the signature and description caps", () => {
    expect(errs({ signature: "" })).toContain("signature:bad-length");
    expect(errs({ signature: "x".repeat(201) })).toContain("signature:bad-length");
    expect(errs({ description: "x".repeat(501) })).toContain("description:bad-length");
  });

  it("requires galaxy.server to be an allowlisted public server or private", () => {
    for (const server of PUBLIC_GALAXY_SERVERS) {
      expect(validateObservation({ ...valid, galaxy: { server } })).toEqual({ ok: true });
    }
    expect(validateObservation({ ...valid, galaxy: { server: "private" } })).toEqual({ ok: true });
    expect(errs({ galaxy: { server: "galaxy.institute.edu" } })).toContain(
      "galaxy.server:not-allowed",
    );
    expect(errs({ galaxy: { server: "test.usegalaxy.org" } })).toContain(
      "galaxy.server:not-allowed",
    );
  });

  it("rejects every leak pattern in signature and in description", () => {
    const leaks: Array<[string, string]> = [
      ["url", "fetch https://usegalaxy.org/api/histories failed"],
      ["home-path", "wrote /Users/alice/run.log"],
      ["home-path", "wrote /home/alice/run.log"],
      ["windows-path", "wrote C:\\Users\\bob\\run.log"],
      ["tilde-path", "wrote ~/analyses/run.log"],
      ["long-hex", "dataset 2a56fb8e4c1d9f70 missing"],
      ["email", "mail alice@institute.edu"],
      ["galaxy-id-phrase", "dataset 42 is in error"],
      ["galaxy-id-phrase", "hid=7 unavailable"],
      ["non-ascii", "r\u00e9sultat manquant"],
    ];
    for (const [pattern, value] of leaks) {
      expect(errs({ signature: value }), `signature ${pattern}`).toContain(`signature:${pattern}`);
      expect(errs({ description: value }), `description ${pattern}`).toContain(
        `description:${pattern}`,
      );
    }
  });

  it("reports field names and pattern names only, never the offending value", () => {
    const res = validateObservation({ ...valid, description: "mail alice@institute.edu" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    for (const e of res.errors) expect(e).not.toContain("alice");
  });
});

describe("scanObservationForLeaks", () => {
  it("is clean for a well-formed observation", () => {
    expect(scanObservationForLeaks(valid)).toEqual([]);
  });

  it("ignores installToken, which is 32 hex by construction", () => {
    expect(scanObservationForLeaks({ ...valid, installToken: "f".repeat(32) })).toEqual([]);
  });

  it("flags a leak in a field the per-field validator does not cover", () => {
    const hits = scanObservationForLeaks({ ...valid, tools: [{ id: "/Users/alice/tool.xml" }] });
    expect(hits).toContain("tools[0].id:home-path");
  });

  it("flags a leak nested under client", () => {
    const hits = scanObservationForLeaks({
      ...valid,
      client: { ...valid.client, version: "0.8.0-alice@box.org" },
    });
    expect(hits.some((h) => h.startsWith("client.version:"))).toBe(true);
  });
});

describe("capObservation", () => {
  it("coerces every field into its cap", () => {
    const capped = capObservation({
      ...valid,
      client: { ...valid.client, version: "v".repeat(60), wsl: false },
      tools: Array(9).fill({ id: "x".repeat(260), version: "y".repeat(60) }),
      mcpTool: "m".repeat(120),
      datatypes: Array(9).fill("d".repeat(60)),
      signature: "s".repeat(400),
      description: "d".repeat(900),
      galaxy: { server: "usegalaxy.org", version: "g".repeat(60) },
    });
    expect(capped.client.version).toHaveLength(40);
    expect(capped.client.wsl).toBeUndefined();
    expect(capped.tools).toHaveLength(5);
    expect(capped.tools[0].id).toHaveLength(200);
    expect(capped.tools[0].version).toHaveLength(40);
    expect(capped.mcpTool).toHaveLength(80);
    expect(capped.datatypes).toHaveLength(5);
    expect(capped.datatypes[0]).toHaveLength(40);
    expect(capped.signature).toHaveLength(200);
    expect(capped.description).toHaveLength(500);
    expect(capped.galaxy.version).toHaveLength(40);
  });

  it("truncates without an ellipsis so the output stays printable ASCII", () => {
    // Not "d" -- a run of 16+ hex letters is itself a long-hex leak.
    const capped = capObservation({ ...valid, description: "z".repeat(900) });
    expect(capped.description).toBe("z".repeat(500));
    expect(validateObservation(capped)).toEqual({ ok: true });
  });

  it("drops empty tool ids and empty datatypes rather than sending blanks", () => {
    const capped = capObservation({
      ...valid,
      tools: [{ id: "" }, { id: "x" }],
      datatypes: ["", "bed"],
    });
    expect(capped.tools).toEqual([{ id: "x" }]);
    expect(capped.datatypes).toEqual(["bed"]);
  });

  it("keeps wsl only when it is true, and omits absent optionals", () => {
    const withWsl = capObservation({ ...valid, client: { ...valid.client, wsl: true } });
    expect(withWsl.client.wsl).toBe(true);
    const bare = capObservation({ ...valid, mcpTool: undefined, galaxy: { server: "private" } });
    expect("mcpTool" in bare).toBe(false);
    expect("version" in bare.galaxy).toBe(false);
  });

  it("round-trips through the validator", () => {
    expect(validateObservation(capObservation(valid))).toEqual({ ok: true });
  });
});

describe("observationByteLength", () => {
  it("measures the serialized payload and a real one fits the Worker cap", () => {
    expect(observationByteLength(valid)).toBe(
      new TextEncoder().encode(JSON.stringify(valid)).length,
    );
    expect(observationByteLength(valid)).toBeLessThan(OBSERVATION_MAX_BYTES);
  });
});

describe("contract addendum: printable ASCII on every string field", () => {
  it("exposes the non-empty-signature fallback literal", () => {
    expect(UNKNOWN_SIGNATURE).toBe("unknown");
    expect(validateObservation({ ...valid, signature: UNKNOWN_SIGNATURE })).toEqual({ ok: true });
  });

  it("rejects a non-ascii tool id, datatype, version or server-adjacent string", () => {
    expect(errs({ tools: [{ id: "résumé-tool" }] })).toContain("tools[0].id:non-ascii");
    expect(errs({ tools: [{ id: "ok", version: "1.0-é" }] })).toContain(
      "tools[0].version:non-ascii",
    );
    expect(errs({ datatypes: ["béd"] })).toContain("datatypes[0]:non-ascii");
    expect(errs({ mcpTool: "galaxy_run_töol" })).toContain("mcpTool:non-ascii");
    expect(errs({ client: { ...valid.client, version: "0.8.0-é" } })).toContain(
      "client.version:non-ascii",
    );
    expect(errs({ galaxy: { server: "usegalaxy.org", version: "24.2.1-é" } })).toContain(
      "galaxy.version:non-ascii",
    );
  });

  it("still reports the single non-ascii error for signature and description", () => {
    expect(errs({ signature: "résultat" })).toContain("signature:non-ascii");
    expect(errs({ description: "résultat" })).toContain("description:non-ascii");
  });

  it("does not flag an ordinary payload", () => {
    expect(validateObservation(valid)).toEqual({ ok: true });
  });
});

describe("client-side leak table", () => {
  // Every one of these is legal under the wire validator, and every one names a
  // machine, a person or a record. Only the client-side table stands between
  // them and the wire.
  const LEAKS: Array<[string, string]> = [
    ["hostname", "Connection refused: galaxy.cancer-center.internal:8080"],
    ["hostname", "could not connect to server postgres-prod.lab.example.edu"],
    ["host-port", "galaxyprod:8080 refused the connection"],
    ["user-at-host", "login alice@localhost failed"],
    ["ipv4", "connection refused by 10.12.4.7"],
    ["ipv6", "ECONNREFUSED [fd00::1:2]:443"],
    ["uuid", "Job for uuid 3f2b8c1a-1234-4abc-8def-a123b56c89ab not found"],
    ["path-separator", "read <path> Documents/patient_jsmith_cohort.csv"],
    ["path-separator", "alice\\Desktop\\cohort.xlsx"],
    ["path-separator", "\\\\fileserver\\alice\\cohort.csv"],
    ["tilde-user", "~alice<path>"],
    ["id-phrase", "history_id=1234 or dataset_id:42"],
    ["id-phrase", "datasets 12 were empty"],
    // The second review's shapes, each sendable before.
    ["hostname", "rsync to galaxy.cancer-center.org_backup failed"],
    ["ipv4", "connect refused node_10.12.4.7 port closed"],
    ["ipv4", "ConnectionError: host=srv_192.168.17.42"],
    ["ipv4", "addr 10.0.0.5x"],
    ["ipv4", "tcp4 a10.12.4.7"],
    ["user-at-host", "User alice@7node rejected"],
    ["user-at-host", "mail to alice@3lab rejected"],
    ["path-separator", "Permission denied: /Alice_Smith"],
    ["path-separator", "Cannot open results/Alice_Smith"],
    ["path-separator", "Cannot open Desktop/patient07"],
    [
      "path-separator",
      "FileNotFoundError: [Errno 2] No such file or directory: '<path> Smith/counts'",
    ],
    ["path-separator", "<path> Doe\\run1"],
    ["scheme-url", "Unable to load s3://alice-study/private_cohort"],
    ["id-phrase", "Could not load dataset id: 42"],
    ["id-phrase", "history id 7 not found"],
    ["id-phrase", "could not merge histories 12 and 13"],
    ["id-phrase", "Job 42 failed; invocation_id=73"],
    // The fix review's shapes.
    ["host-port", "Connection to galaxyprod:443 refused"],
    ["host-port", "localhost:80 down"],
    ["host-port", "Connection to galaxy_prod:8080 refused"],
    ["host-port", "Connection to galaxyprod:123456 refused"],
    ["path-separator", "File %2FUsers%2Falice%2Fx.txt missing"],
    ["id-phrase", "history number 12 not found"],
    ["id-phrase", "dataset no. 42 is empty"],
  ];

  for (const [name, text] of LEAKS) {
    it(`${name}: ${text}`, () => {
      expect(validateObservation({ ...valid, signature: text }), "wire-legal").toEqual({
        ok: true,
      });
      expect(textLeaks(text)).toContain(name);
      expect(scanObservationForLeaks({ ...valid, signature: text })).toContain(`signature:${name}`);
      expect(scanObservationForLeaks({ ...valid, description: text })).toContain(
        `description:${name}`,
      );
    });
  }

  it("leaves ordinary Galaxy messages alone", () => {
    for (const text of [
      "ToolExecutionError: dataset <id> in history <n> failed; wrote <path> see <url> mail <email>",
      "expected fastqsanger.gz input",
      "pass or fail at 12:30:45",
      "tool hisat2 2.2.1+galaxy1 failed",
      // Real Galaxy and Python error shapes that an earlier, looser hostname
      // rule dropped.
      "Error: sample.fastq.gz is empty",
      "galaxy.tools.parameters.basic.ParameterValueError: parameter 'x': an invalid option",
      "No module named numpy.core.multiarray",
      "Job 3 is in error state",
      "HTTPError:400 Bad Request at line:42",
    ]) {
      expect(textLeaks(text), text).toEqual([]);
    }
  });

  it("refuses any path separator, ordinary prose included", () => {
    // The fail-closed cost of the path rule: from here a slash in prose can't
    // be told apart from the tail of a path.
    for (const text of ["Galaxy 24.2.1 rejected input/output mapping", "pass and/or fail"]) {
      expect(textLeaks(text), text).toEqual(["path-separator"]);
    }
  });

  it("cannot see a single-label host or an unlisted suffix (a known limit)", () => {
    // No pattern tells `galaxyprod` from a word. This is why auto mode sends
    // no free text: only a human reading the ask confirm can catch these.
    for (const text of ["Cannot resolve galaxyprod", "Cannot resolve galaxy.hospital"]) {
      expect(textLeaks(text), text).toEqual([]);
    }
  });

  it("does not apply the hostname rule to a toolshed tool id", () => {
    expect(scanObservationForLeaks(valid)).toEqual([]);
  });
});
