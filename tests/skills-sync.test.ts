/**
 * Unit tests for the vendoring sync script.
 *
 * The CI drift gate hashes the vendored bytes against the manifest beside them,
 * which proves nobody hand-edited the tree and proves nothing about the
 * transform that produced it. A transform that mangles content re-syncs, writes
 * a fresh hash, and passes. These cover the transform itself and the four ways
 * `--check` is supposed to fail.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter as parseFrontmatterTs } from "../extensions/loom/skills-discovery";
import { readVendorManifest, vendorSkillsDir } from "../extensions/loom/vendor-skills";
import {
  REPO_BLOB_BASE,
  applyTransforms,
  checkVendored,
  declaredTargets,
  buildCatalogEntries,
  findJsonStringSpans,
  listCommittedFiles,
  matchesPattern,
  parseFrontmatter,
  rewriteLocalPaths,
  safeVendorPath,
  selectFiles,
  sha256,
  stripWikiLinks,
} from "../scripts/sync-skills.mjs";

describe("sha256", () => {
  // The Windows CI leg checks out CRLF. Hashing the bytes on disk would fail
  // that leg and only that leg, which is the worst kind of red.
  it("is stable across LF and CRLF", () => {
    const lf = "one\ntwo\nthree\n";
    expect(sha256(lf.replace(/\n/g, "\r\n"))).toBe(sha256(lf));
  });

  it("still distinguishes content that actually differs", () => {
    expect(sha256("one\ntwo\n")).not.toBe(sha256("one\nTWO\n"));
  });
});

describe("stripWikiLinks", () => {
  it("strips a plain link to its note name", () => {
    expect(stripWikiLinks("See [[galaxy-collection-semantics]] for the shapes.")).toBe(
      "See galaxy-collection-semantics for the shapes.",
    );
  });

  it("keeps the alias when the link has one, and the whole body when it does not", () => {
    // The planemo notes are full of `[[tests-format#has_size_model|has_size]]`,
    // inside a table. Rendering that as `tests-format#has_size_model|has_size`
    // is noise, and the raw pipe breaks the table row it sits in.
    expect(stripWikiLinks("use [[tests-format#has_size_model|has_size]] here")).toBe(
      "use has_size here",
    );
    // The anchor stays on an unpiped link: it says where in the page to look.
    expect(stripWikiLinks("see [[tests-format#has_text_model]]")).toBe(
      "see tests-format#has_text_model",
    );
  });

  it("leaves a link alone inside an inline code span", () => {
    expect(stripWikiLinks("use `[[literal]]` verbatim")).toBe("use `[[literal]]` verbatim");
  });

  it("carries no mask character into the output", () => {
    // The fence and span mask is length-preserving so offsets still index the
    // original; reading the capture off the masked copy instead would ship it.
    const out = stripWikiLinks("a [[one]] b `c` d [[two|2]] e");
    expect(out).toBe("a one b `c` d 2 e");
    expect(out).not.toMatch(/\u0000/);
  });

  it("leaves 2D array literals inside a code fence alone", () => {
    // galaxy-skills' apply-rules reference documents the Apply Rules DSL with
    // fenced `data: [[cell values]]` blocks. `[[` there opens an array, not a
    // link, and stripping the brackets changes what the DSL example means.
    const doc = [
      "Prose pointing at [[apply-rules]].",
      "",
      "```",
      "data: [[cell values]]",
      'data: [["a", "b", "c"]]',
      "```",
      "",
      "More prose.",
    ].join("\n");
    const out = stripWikiLinks(doc);
    expect(out).toContain("data: [[cell values]]");
    expect(out).toContain('data: [["a", "b", "c"]]');
    expect(out).toContain("Prose pointing at apply-rules.");
  });

  it("leaves an array literal alone even unfenced, because no note name has a quote or comma", () => {
    expect(stripWikiLinks('Output: [["foo", "oo"]]')).toBe('Output: [["foo", "oo"]]');
  });

  it("leaves an unfenced array literal alone, because a note name has no space", () => {
    // Every wiki-link in the vendored casts is a kebab-case file stem. `[[cell
    // values]]` is indistinguishable from a link by brackets alone, so the note
    // name is what tells them apart.
    expect(stripWikiLinks("data: [[cell values]]")).toBe("data: [[cell values]]");
  });

  it("does not let a tilde fence close a backtick one", () => {
    // CommonMark closes a fence only with the same character. Toggling on any
    // fence line would start rewriting the rest of a code block as prose.
    const doc = ["```", "[[a]]", "~~~", "[[b]]", "```", "[[c]]"].join("\n");
    expect(stripWikiLinks(doc)).toBe(["```", "[[a]]", "~~~", "[[b]]", "```", "c"].join("\n"));
  });

  it("keeps the text of a same-note anchor link rather than emptying it", () => {
    expect(stripWikiLinks("See [[#Requirements]] above.")).toBe("See #Requirements above.");
  });

  it("leaves a degenerate link alone rather than guessing", () => {
    // Neither form appears anywhere in the vendored corpus, and both are
    // ambiguous enough that passing them through reads better than a guess.
    expect(stripWikiLinks("See [[note|]] above.")).toBe("See [[note|]] above.");
    expect(stripWikiLinks("See [[a|b|c]] above.")).toBe("See [[a|b|c]] above.");
  });

  it("resumes stripping after the fence closes", () => {
    const doc = ["```yaml", "data: [[cell values]]", "```", "Back to [[prose-note]]."].join("\n");
    expect(stripWikiLinks(doc)).toBe(
      ["```yaml", "data: [[cell values]]", "```", "Back to prose-note."].join("\n"),
    );
  });
});

describe("rewriteLocalPaths", () => {
  it("rewrites a mapped repo to its GitHub blob base", () => {
    expect(
      rewriteLocalPaths("see ~/projects/repositories/galaxy/lib/galaxy/jobs/__init__.py"),
    ).toBe(`see ${REPO_BLOB_BASE.galaxy}lib/galaxy/jobs/__init__.py`);
  });

  it("keys a multi-project checkout on its subdirectory", () => {
    // One cited checkout holds clones of several projects. The notes name the
    // iwc-src mapping themselves; the sibling nf-core clones have no
    // established upstream, so a name-keyed rule would point them at the wrong
    // repository and must fail instead.
    expect(
      rewriteLocalPaths("see ~/projects/repositories/workflow-fixtures/iwc-src/workflows/"),
    ).toBe("see https://github.com/galaxyproject/iwc/blob/main/workflows/");
    expect(() =>
      rewriteLocalPaths("see ~/projects/repositories/workflow-fixtures/pipelines/nf-core__sarek/"),
    ).toThrow(/workflow-fixtures\/pipelines/);
  });

  it("rewrites planemo too, because the Foundry notes leak both", () => {
    expect(rewriteLocalPaths("see ~/projects/repositories/planemo/docs/writing_tests.rst")).toBe(
      `see ${REPO_BLOB_BASE.planemo}docs/writing_tests.rst`,
    );
  });

  it("rewrites the expanded home-directory form too", () => {
    // The notes write the checkout root as `~/` in some places and as the
    // expanded `/Users/<someone>/` in others. The expanded form also carries
    // the author's account name, which must not reach the published package.
    expect(rewriteLocalPaths("see /Users/someone/projects/repositories/galaxy/lib/x.py")).toBe(
      `see ${REPO_BLOB_BASE.galaxy}lib/x.py`,
    );
    expect(() =>
      rewriteLocalPaths("see /Users/someone/projects/repositories/private-vault/notes.md"),
    ).toThrow(/private-vault/);
  });

  it("does not mistake an inherited property for a rewrite rule", () => {
    // `bases["constructor"]` is truthy, so a plain truthiness check would
    // splice a native-code stringification into shipped guidance.
    expect(() => rewriteLocalPaths("see ~/projects/repositories/constructor/x.py")).toThrow(
      /constructor/,
    );
  });

  it("fails loudly on a repo it has no rewrite for", () => {
    // Shipping the raw path would point the agent at a directory that only
    // exists on the note author's machine, and Loom's read-jail blocks it, so
    // the turn is wasted rather than merely wrong.
    expect(() => rewriteLocalPaths("see ~/projects/repositories/tpv/config.yml")).toThrow(/tpv/);
  });

  it("leaves a slashless reference for the residue check to catch", () => {
    // The rewrite only recognises a trailing slash; the assertion that nothing
    // slipped through runs once, over every vendored file, in applyTransforms.
    expect(rewriteLocalPaths("cloned into ~/projects/repositories/galaxy")).toBe(
      "cloned into ~/projects/repositories/galaxy",
    );
  });
});

describe("applyTransforms", () => {
  const both = ["rewrite-local-paths", "strip-wiki-links"];

  it("rewrites markdown whatever the case of the extension, and leaves yaml alone", () => {
    const yml = "note: some/relative/path.py and [[a-link]]\n";
    expect(applyTransforms(yml, "galaxy-collection-semantics.yml", both)).toBe(yml);
    expect(applyTransforms("[[a-link]]", "SHOUTING.MD", both)).toBe("a-link");
  });

  it("applies no rewrite when a plugin declares no transforms", () => {
    // The wiki-link strip and the path rewrite correct how the Foundry authors
    // its notes. Running them over content that never had the problem is how a
    // sync quietly corrupts something, so they are opt-in per plugin.
    const md = "keeps [[its-links]] verbatim\n";
    expect(applyTransforms(md, "a.md", [])).toBe(md);
  });

  it("refuses a local-checkout path in any file type, transforms or not", () => {
    // The rewrite is markdown-only, but the leak check is an assertion. A
    // sidecar naming the author's home directory would otherwise ship, with
    // their account name, to npm and into every installer.
    for (const [target, transforms] of [
      ["notes.md", both],
      ["notes.md", []],
      ["semantics.yml", both],
      ["_provenance.json", both],
    ] as [string, string[]][]) {
      // Markdown with the rewrite on refuses at the unmapped repo; everything
      // else refuses at the residue assertion. Either way it does not ship.
      expect(() =>
        applyTransforms("cited at /Users/someone/projects/repositories/x/y.py", target, transforms),
      ).toThrow(/no GitHub base|home directory/);
    }
  });

  it("strips wiki-links from the prose a cli reference carries in its body", () => {
    // A cast's references/cli/*.json holds a whole markdown document in `body`,
    // and its SKILL.md tells the agent to read the file. Everywhere else in
    // these files a [[name]] is an identifier, so only that field is touched.
    const doc = JSON.stringify({
      tool: "gxwf",
      ref: "[[an-identifier]]",
      body: "see [[validate]]",
    });
    const out = applyTransforms(doc, "references/cli/x.json", both);
    const parsed = JSON.parse(out);
    expect(parsed.body).toBe("see validate");
    expect(parsed.ref).toBe("[[an-identifier]]");
    expect(parsed.tool).toBe("gxwf");
  });

  it("refuses a transform name it does not know", () => {
    expect(() => applyTransforms("x", "a.md", ["make-it-nice"])).toThrow(/make-it-nice/);
  });
});

describe("matchesPattern", () => {
  it("keeps a single star inside one path segment", () => {
    expect(matchesPattern("notes/*.md", "notes/a.md")).toBe(true);
    expect(matchesPattern("notes/*.md", "notes/deep/a.md")).toBe(false);
  });

  it("lets a double star cross segments", () => {
    expect(matchesPattern("cast/**", "cast/references/notes/a.md")).toBe(true);
    expect(matchesPattern("cast/**", "other/a.md")).toBe(false);
  });

  it("treats dots as literal", () => {
    expect(matchesPattern("a.md", "axmd")).toBe(false);
  });
});

const AVAILABLE = [
  "cast/SKILL.md",
  "cast/_feedback.md",
  "cast/_provenance.json",
  "cast/references/notes/one.md",
  "other-cast/SKILL.md",
];

describe("selectFiles", () => {
  it("mirrors a glob under the plugin prefix", () => {
    const files = selectFiles(
      { plugin: "p", as: "bundled", include: ["cast/**"], exclude: ["cast/_feedback.md"] },
      AVAILABLE,
    );
    expect(files.map((f: { target: string }) => f.target)).toEqual([
      "bundled/cast/SKILL.md",
      "bundled/cast/_provenance.json",
      "bundled/cast/references/notes/one.md",
    ]);
  });

  it("honours an explicit target for one file", () => {
    const files = selectFiles(
      { plugin: "p", as: "", include: [{ source: "cast/SKILL.md", target: "flat.md" }] },
      AVAILABLE,
    );
    expect(files).toEqual([{ source: "cast/SKILL.md", target: "flat.md", why: undefined }]);
  });

  it("fails when an include matches nothing", () => {
    // A cast renamed upstream should stop the sync rather than quietly shrink
    // what ships, which is invisible in a diff of generated files.
    expect(() => selectFiles({ plugin: "p", as: "", include: ["gone/**"] }, AVAILABLE)).toThrow(
      /matched nothing/,
    );
    expect(() =>
      selectFiles(
        { plugin: "p", as: "", include: [{ source: "gone.md", target: "x.md" }] },
        AVAILABLE,
      ),
    ).toThrow(/does not exist upstream/);
  });

  it("refuses a target that would be written outside the vendor tree", () => {
    for (const entry of [
      { plugin: "p", as: "", include: [{ source: "cast/SKILL.md", target: "../../pwned.md" }] },
      { plugin: "p", as: "../..", include: ["cast/SKILL.md"] },
    ]) {
      expect(() => selectFiles(entry, AVAILABLE)).toThrow(/leaves the vendor tree/);
    }
  });

  it("fails when two sources land on the same target", () => {
    expect(() =>
      selectFiles(
        {
          plugin: "p",
          as: "",
          include: [
            { source: "cast/SKILL.md", target: "x.md" },
            { source: "other-cast/SKILL.md", target: "x.md" },
          ],
        },
        AVAILABLE,
      ),
    ).toThrow(/both vendor as x.md/);
  });
});

const PIN = {
  repo: "galaxyproject/agentic-plugins",
  commit: "aa4da4bd68eb00e360dfd5aa6e998feb5de0ac49",
  manifestSha: "m",
  syncSha: "s",
};

function check(overrides: Record<string, unknown> = {}) {
  return checkVendored({
    source: PIN,
    vendored: PIN,
    declared: ["a.md"],
    recorded: [{ target: "a.md", sha256: "aaa" }],
    present: ["a.md"],
    hashOf: () => "aaa",
    ...overrides,
  }) as { kind: string; message: string }[];
}

describe("checkVendored", () => {
  it("passes when the pin, the manifest and the disk agree", () => {
    expect(check()).toEqual([]);
  });

  it("catches a manifest edited without a re-sync", () => {
    // Which files a glob selects cannot be recomputed offline, so hashing the
    // manifest is the only way the gate notices a changed selection.
    const failures = check({ vendored: { ...PIN, manifestSha: "two" } });
    expect(failures).toEqual([
      { kind: "moved-pin", message: "the manifest changed but files were not re-synced" },
    ]);
  });

  it("catches an edited transform that was never re-synced", () => {
    // The transforms decide what the vendored bytes are, and nothing else in
    // the gate can see a change to them.
    const failures = check({ vendored: { ...PIN, syncSha: "other" } });
    expect(failures).toEqual([
      { kind: "moved-pin", message: "the sync script changed but files were not re-synced" },
    ]);
  });

  it("treats a missing hash as a failure, not as a check to skip", () => {
    // A recorded tree with no hash was written by something that did not record
    // one, which is exactly the case the hash exists to catch.
    const failures = check({ vendored: { repo: PIN.repo, commit: PIN.commit } });
    expect(failures.map((f) => f.message)).toEqual([
      "_manifest.json records no hash for the manifest",
      "_manifest.json records no hash for the sync script",
    ]);
  });

  it("catches a pin that moved without a re-sync", () => {
    const failures = check({ source: { ...PIN, commit: "0".repeat(40) } });
    expect(failures.map((f) => f.kind)).toEqual(["moved-pin"]);
  });

  it("catches a target the manifest asks for but the sync never wrote", () => {
    const failures = check({ declared: ["a.md", "b.md"] });
    expect(failures).toEqual([
      { kind: "missing", message: "b.md: in the manifest but not vendored" },
    ]);
  });

  it("catches a recorded target that is gone from disk", () => {
    const failures = check({ present: [] });
    expect(failures.map((f) => f.kind)).toEqual(["missing"]);
  });

  it("catches a vendored file the manifest no longer asks for", () => {
    const failures = check({
      declared: [],
      recorded: [],
      present: ["a.md"],
      hashOf: () => null,
    });
    expect(failures).toEqual([
      { kind: "orphaned", message: "a.md: on disk but not in _manifest.json" },
    ]);
  });

  it("catches a hand-edited file", () => {
    const failures = check({ hashOf: () => "bbb" });
    expect(failures.map((f) => f.kind)).toEqual(["hash-mismatch"]);
  });

  it("skips the declared-target comparison when the selection is by pattern", () => {
    // A glob cannot be re-evaluated offline, so the gate falls back to
    // comparing the recorded manifest against what is on disk.
    expect(check({ declared: null })).toEqual([]);
  });
});

describe("declaredTargets", () => {
  const manifest = (over: Record<string, unknown> = {}) => ({
    plugins: [
      {
        plugin: "p",
        as: "bundled",
        include: [
          { source: "a.md", target: "a.md" },
          { source: "b.md", target: "b.md" },
        ],
        exclude: [],
        ...over,
      },
    ],
  });

  it("prefixes explicit targets with the plugin's prefix", () => {
    expect(declaredTargets(manifest())).toEqual(["bundled/a.md", "bundled/b.md"]);
  });

  it("does not declare an explicit include that an exclude also matches", () => {
    // sync skips it, so counting it here would make `sync && check` fail on a
    // manifest that is perfectly consistent.
    expect(declaredTargets(manifest({ exclude: ["b.md"] }))).toEqual(["bundled/a.md"]);
  });

  it("gives up entirely once anything is selected by pattern", () => {
    expect(declaredTargets(manifest({ include: ["a*.md"] }))).toBeNull();
  });
});

describe("the ported frontmatter parser", () => {
  // The sync runs under plain node and cannot import the TypeScript parser, so
  // there are two of them. A drift between the two shows up as a catalog whose
  // descriptions or surface tags disagree with what the runtime would read from
  // the same bytes -- silently, and only for skills nobody re-reads.
  const CASES: [string, string][] = [
    ["no frontmatter", "# Just a heading\n"],
    ["empty frontmatter", "---\n\n---\nbody"],
    ["malformed yaml", "---\nname: [unclosed\n---\nbody"],
    ["scalar yaml", "---\njust a string\n---\nbody"],
    ["plain", "---\nname: a\ndescription: d\n---\n"],
    [
      "surfaces as a list",
      "---\nname: a\ndescription: d\nmetadata:\n  surfaces: [loom, cli]\n---\n",
    ],
    ["surfaces as a string", "---\nname: a\ndescription: d\nmetadata:\n  surfaces: loom\n---\n"],
    ["surfaces with junk", "---\nname: a\nmetadata:\n  surfaces: [loom, 3, '', '  x  ']\n---\n"],
    ["surfaces not under metadata", "---\nname: a\nsurfaces: [loom]\n---\n"],
    ["when_to_use padded", "---\nname: a\nwhen_to_use: '  use me  '\n---\n"],
    ["non-string name", "---\nname: 7\ndescription: d\n---\n"],
    ["crlf", "---\r\nname: a\r\ndescription: d\r\n---\r\nbody"],
  ];

  it.each(CASES)("agrees with the runtime parser on %s", (_label, text) => {
    expect(parseFrontmatter(text)).toEqual(parseFrontmatterTs(text));
  });

  it("agrees on every vendored SKILL.md", () => {
    const manifest = readVendorManifest()!;
    const skillFiles = manifest.files.filter((f) => f.target.endsWith("SKILL.md"));
    expect(skillFiles.length).toBeGreaterThan(0);
    for (const f of skillFiles) {
      const text = fs.readFileSync(join(vendorSkillsDir(), f.target), "utf-8");
      expect(parseFrontmatter(text)).toEqual(parseFrontmatterTs(text));
    }
  });
});

describe("buildCatalogEntries", () => {
  const plugin = { plugin: "p" };
  const skill = (name: string, surfaces: string) =>
    `---\nname: ${name}\ndescription: about ${name}\nmetadata:\n  surfaces: ${surfaces}\n---\n`;

  it("keeps every skill, tagged or not, at the path a fetch would use", () => {
    // selectSkills does the filtering at render time; the catalog is the whole
    // repo so a retagged skill upstream does not need a Loom change.
    const files = [
      { source: "a/SKILL.md", target: "skills/a/SKILL.md" },
      { source: "b/SKILL.md", target: "skills/b/SKILL.md" },
      { source: "a/references/deep.md", target: "skills/a/references/deep.md" },
    ];
    const text: Record<string, string> = {
      "a/SKILL.md": skill("a", "[loom]"),
      "b/SKILL.md": skill("b", "[]"),
    };
    const entries = buildCatalogEntries(plugin, files, (f: { source: string }) => text[f.source]);
    expect(entries).toEqual([
      { path: "skills/a/SKILL.md", name: "a", description: "about a", surfaces: ["loom"] },
      { path: "skills/b/SKILL.md", name: "b", description: "about b", surfaces: [] },
    ]);
  });

  it("refuses a plugin with nothing tagged for this surface", () => {
    // The router is tag-or-all, so an untagged mirror puts every skill it holds
    // into the cached system prompt instead of none of them.
    const files = [{ source: "b/SKILL.md", target: "skills/b/SKILL.md" }];
    expect(() => buildCatalogEntries(plugin, files, () => skill("b", "[]"))).toThrow(
      /no skill tagged/,
    );
  });

  it("refuses a SKILL.md with no name or description", () => {
    const files = [{ source: "b/SKILL.md", target: "skills/b/SKILL.md" }];
    expect(() => buildCatalogEntries(plugin, files, () => "# no frontmatter\n")).toThrow(
      /no name or description/,
    );
  });

  it("refuses a router plugin that vendors no SKILL.md at all", () => {
    expect(() =>
      buildCatalogEntries(plugin, [{ source: "x.md", target: "x.md" }], () => ""),
    ).toThrow(/vendors no SKILL.md/);
  });
});

describe("listCommittedFiles", () => {
  // What a checkout contains and what its commit contains are different sets,
  // and only the second one is covered by the provenance the sync records.
  let repo: string;
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd: repo,
      encoding: "utf-8",
    });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loom-tree-"));
    mkdirSync(join(repo, "plugins", "p", "skills", "example"), { recursive: true });
    writeFileSync(
      join(repo, "plugins", "p", "skills", "example", "SKILL.md"),
      "---\nname: a\n---\n",
    );
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "first");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const listed = () => listCommittedFiles(repo, "HEAD", "plugins/p/skills") as string[];

  it("lists what the commit holds", () => {
    expect(listed()).toEqual(["example/SKILL.md"]);
  });

  it("ignores a file the commit does not have, however it got there", () => {
    // An ignored file leaves `git status --porcelain` empty, so the sync would
    // have recorded a clean pin and shipped it. A `.env` is the bad case.
    writeFileSync(join(repo, "plugins", "p", "skills", "example", ".env"), "SECRET=x\n");
    writeFileSync(join(repo, "plugins", "p", "skills", "example", "scratch.md"), "notes\n");
    expect(git("status", "--porcelain").stdout).not.toContain(".env");
    expect(listed()).toEqual(["example/SKILL.md"]);
  });

  it("refuses a symlink rather than following it out of the source tree", () => {
    symlinkSync("/etc/hosts", join(repo, "plugins", "p", "skills", "example", "linked.md"));
    git("add", "-A");
    git("commit", "-qm", "link");
    expect(() => listed()).toThrow(/not a regular file/);
  });
});

describe("what the write side refuses", () => {
  it("rejects a Windows-separated traversal target", () => {
    // `..\..\x.md` has no forward slash, so splitting on "/" alone saw one
    // harmless segment while path.join on Windows walked out of the tree.
    for (const target of ["..\\..\\outside.md", "C:\\outside.md", "\\outside.md"]) {
      expect(() =>
        selectFiles({ plugin: "p", as: "", include: [{ source: "a.md", target }] }, ["a.md"]),
      ).toThrow(/leaves the vendor tree/);
    }
  });
});

describe("rewriteLocalPaths containment", () => {
  it("refuses a path that walks out of the repository it maps to", () => {
    // Only the prefix is replaced, so the rest rides into the URL. A reader
    // resolving `.../galaxy/blob/dev/../../../../evil/repo/...` lands somewhere
    // else entirely.
    expect(() =>
      rewriteLocalPaths("~/projects/repositories/galaxy/../../../../evil/repo/blob/main/a.md"),
    ).toThrow(/walks out of the repository/);
  });

  it("still rewrites an ordinary deep path", () => {
    expect(rewriteLocalPaths("~/projects/repositories/galaxy/lib/galaxy/jobs/__init__.py")).toBe(
      `${REPO_BLOB_BASE.galaxy}lib/galaxy/jobs/__init__.py`,
    );
  });
});

describe("home-directory paths", () => {
  const both = ["rewrite-local-paths", "strip-wiki-links"];

  it.each([
    ["a non-ASCII username in a layout we map", "/Users/joé/projects/repositories/galaxy/lib/x.py"],
    ["any other layout under a user directory", "/Users/alice/work/galaxy/lib/x.py"],
    ["a linux home", "/home/carol/scratch/notes.md"],
    ["a Windows home", "C:\\Users\\bob\\projects\\repositories\\galaxy\\x.py"],
    ["a bare tilde path that is not a tool cache", "~/notes/private.md"],
  ])("refuses or rewrites %s rather than publishing it", (_label, cited) => {
    let out: string;
    try {
      out = applyTransforms(`cited at ${cited}`, "a.md", both) as string;
    } catch {
      return; // refused outright, which is the other acceptable answer
    }
    expect(out).not.toContain(cited);
    expect(out).not.toMatch(/\/(?:Users|home)\/[^/\s]+\//);
  });

  it.each(["~/.cache/gxwf", "~/.config/claude/x.json", "~/.claude/skills/y", "~/.foundry/iwc"])(
    "leaves the tool cache %s alone",
    (cited) => {
      expect(applyTransforms(`run against ${cited}`, "a.md", both)).toBe(`run against ${cited}`);
    },
  );
});

describe("findJsonStringSpans", () => {
  it("finds the field's own literal, not another with the same value", () => {
    const text = '{"ref": "[[x]]", "body": "[[x]]"}';
    const spans = findJsonStringSpans(text, "body", "[[x]]") as [number, number][];
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0][0], spans[0][1])).toBe('"[[x]]"');
    expect(text.slice(0, spans[0][0])).toContain('"ref"');
  });

  it("finds a literal written with unicode escapes", () => {
    const text = '{"body":"see \\u005b\\u005bvalidate\\u005d\\u005d"}';
    expect(findJsonStringSpans(text, "body", "see [[validate]]")).toHaveLength(1);
  });
});

describe("safeVendorPath", () => {
  // The guard the write actually uses. The suite above exercises selectFiles,
  // which is the selection side; this is the one that sees a resolved path.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-vendor-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts a nested target under the vendor directory", () => {
    expect(safeVendorPath("cast/references/a.md", dir)).toBe(join(dir, "cast/references/a.md"));
  });

  it("refuses a path that resolves out of it", () => {
    expect(() => safeVendorPath("../escape.md", dir)).toThrow(/outside the vendor directory/);
  });

  it("refuses a path whose parent directory is a symlink", () => {
    // mkdirSync(..., {recursive:true}) is satisfied by an existing symlinked
    // directory and the write goes straight through it, so checking only the
    // final component is not enough.
    const outside = mkdtempSync(join(tmpdir(), "loom-outside-"));
    try {
      mkdirSync(join(dir, "cast"), { recursive: true });
      symlinkSync(outside, join(dir, "cast", "notes"));
      expect(() => safeVendorPath("cast/notes/a.md", dir)).toThrow(/through a symlink/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("staysUnder, via rewriteLocalPaths", () => {
  it.each([
    ["literal", "../../../../evil/repo/blob/main/a.md"],
    ["backslash", "..\\..\\..\\..\\evil\\repo\\blob\\main\\a.md"],
    ["percent-encoded", "%2e%2e/%2e%2e/%2e%2e/%2e%2e/evil/repo/blob/main/a.md"],
    ["double-encoded", "%252e%252e/%252e%252e/%252e%252e/%252e%252e/evil/x.md"],
  ])("refuses a %s traversal in the suffix", (_label, suffix) => {
    // Checking the spelling is a losing game; all four normalize to the same URL
    // in whatever resolves the link, so the produced URL is what gets checked.
    expect(() => rewriteLocalPaths(`~/projects/repositories/galaxy/${suffix}`)).toThrow(
      /walks out of the repository/,
    );
  });

  it("refuses one that escapes a two-segment mapping too", () => {
    expect(() =>
      rewriteLocalPaths("~/projects/repositories/workflow-fixtures/iwc-src/../../evil/x.md"),
    ).toThrow(/walks out of the repository/);
  });

  it("names the repository, not the subdirectory, when a mapping is missing", () => {
    // `some-new-repo/lib` as the suggested key produces a map entry that covers
    // one directory and fails again on the next citation in the same repo.
    expect(() => rewriteLocalPaths("~/projects/repositories/some-new-repo/lib/thing.py")).toThrow(
      /add "some-new-repo" to REPO_BLOB_BASE/,
    );
  });
});

describe("applyJsonTransforms nesting", () => {
  it("refuses prose it cannot reach rather than shipping it untransformed", () => {
    const nested = JSON.stringify({ command: { body: "see [[validate]]" } });
    expect(() => applyTransforms(nested, "x.json", ["strip-wiki-links"])).toThrow(/nested "body"/);
  });

  it("leaves a nested body alone when it has no links to strip", () => {
    const nested = JSON.stringify({ command: { body: "ordinary prose" } });
    expect(applyTransforms(nested, "x.json", ["strip-wiki-links"])).toBe(nested);
  });
});
