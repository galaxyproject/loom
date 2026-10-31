/**
 * Vendor the galaxy-skills corpus into the agent at build time.
 *
 * Orbit fetches skills from GitHub on demand and caches them for 24h. The browser ships
 * them instead: the browser has no writable cache to persist across sessions, and a
 * per-turn fetch would put a GitHub round trip on the critical path of an agent that
 * is supposed to load like a web page. Vendoring also pins the corpus to the build,
 * which suits a plugin that is installed once and served to every user.
 *
 * The trust property survives the change. Orbit restricts skill repos to
 * `github.com/galaxyproject/*` because SKILL.md content is treated as authoritative
 * agent instructions, so an arbitrary repo is a prompt-injection vector. Vendoring
 * enforces that more strongly: the corpus is fixed at build time and the running
 * agent cannot be pointed at another repo at all.
 *
 * The corpus itself is a build artifact (gitignored), but `skills.lock.json` beside
 * this package's package.json is committed and pins the exact commit. Without the lock every build
 * would silently take whatever `main` points at that day, which is a poor foundation
 * for a project whose claim is reproducibility.
 *
 * In this repo the corpus comes from Orbit's own vendor tree instead: scripts/sync-skills.mjs
 * copies galaxy-skills out of galaxyproject/agentic-plugins into extensions/orbit/vendor/skills,
 * and when that tree's _manifest.json is present this copies the same files from it and pins
 * the lock to the manifest's upstream commit. One manifest bump then moves both shells, and the
 * build makes no GitHub round trip, so in this repo the pin moves through
 * scripts/skills.manifest.json only: a lock moved any other way fails check_vendored.py and the
 * next build puts it back. Under CI the build refuses a lock that disagrees instead of rewriting
 * it. GitHub stays the fallback for an explicit GALAXY_SKILLS_REPO or GALAXY_SKILLS_REF, and for
 * a checkout of browser/ alone, where GALAXY_SKILLS_REF is how the pin moves: the lock is
 * rewritten and the change shows up in review.
 *
 * Env:
 *   GALAXY_SKILLS_REPO  owner/repo      (default galaxyproject/galaxy-skills)
 *   GALAXY_SKILLS_REF   branch or sha   (default: the lock, else main)
 *   GITHUB_TOKEN        optional, raises the API rate limit
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.GALAXY_SKILLS_REPO || "galaxyproject/galaxy-skills";
// The core package, wherever npm runs this from.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEST = join(ROOT, "src", "agent", "skills", "galaxy-skills");
const STAMP = join(DEST, "VENDORED.json");
const LOCK = join(ROOT, "skills.lock.json");
// Orbit's vendor tree, two levels above the core when it sits in the loom repo.
const VENDOR = join(ROOT, "..", "..", "extensions", "orbit", "vendor", "skills");
const VENDOR_MANIFEST = join(VENDOR, "_manifest.json");

// The allowlist Orbit applies at runtime, applied here at build time instead.
const ALLOWED_OWNER = "galaxyproject";

function headers() {
  const h = { "User-Agent": "orbit-browser-skills-vendor", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) {
    h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

async function api(path) {
  const res = await fetch(`https://api.github.com/${path}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} failed: HTTP ${res.status}`);
  }
  return res.json();
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

/** The ref to vendor: an explicit override, else the committed lock, else main. */
async function resolveRef() {
  if (process.env.GALAXY_SKILLS_REF) {
    return { ref: process.env.GALAXY_SKILLS_REF, source: "GALAXY_SKILLS_REF" };
  }
  const lock = await readJson(LOCK);
  if (lock?.sha) {
    return { ref: lock.sha, source: "skills.lock.json" };
  }
  return { ref: "main", source: "default" };
}

async function resolveSha(ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) {
    return ref;
  }
  const data = await api(`repos/${REPO}/commits/${encodeURIComponent(ref)}`);
  return data.sha;
}

/** The id git gives a blob, which is what the tree listing states for each file. */
function blobSha(content) {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** The agent-facing subtree. `dev-skills/` assumes a checkout, a shell and planemo. */
const SUBTREE = "skills/";
/** Kept beside the corpus because vendoring someone's text without their licence is rude. */
const ALSO = new Set(["LICENSE"]);

/** Where a blob lands under DEST: the subtree prefix is stripped, so paths stay short. */
function localPath(path) {
  return path.startsWith(SUBTREE) ? path.slice(SUBTREE.length) : path;
}

async function listBlobs(sha) {
  const tree = await api(`repos/${REPO}/git/trees/${sha}?recursive=1`);
  if (tree.truncated) {
    // A partial tree would silently drop skills; refuse rather than vendor it.
    throw new Error("GitHub returned a truncated tree; refusing a partial corpus");
  }
  return (tree.tree || [])
    .filter((n) => n.type === "blob" && typeof n.path === "string")
    .filter((n) => n.path.startsWith(SUBTREE) || ALSO.has(n.path));
}

async function download(sha, blob) {
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${blob.path}`;
  const res = await fetch(url, { headers: { "User-Agent": "orbit-browser-skills-vendor" } });
  if (!res.ok) {
    throw new Error(`fetch ${blob.path} failed: HTTP ${res.status}`);
  }
  const content = Buffer.from(await res.arrayBuffer());
  const got = blobSha(content);
  if (got !== blob.sha) {
    throw new Error(`${blob.path}: blob ${got} does not match the tree's ${blob.sha}`);
  }
  return content;
}

/** owner/repo from the manifest's upstream URL, held to the same owner allowlist. */
function upstreamRepo(url) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url ?? "");
  if (!m || !m[1].startsWith(`${ALLOWED_OWNER}/`)) {
    throw new Error(`refusing the vendored skills' upstream "${url}"`);
  }
  return m[1];
}

/**
 * Copy the galaxy-skills plugin out of Orbit's vendor tree, checked against its manifest. Found by
 * repo rather than by its `skills/` prefix: Orbit's staging skills are vendored under the same
 * prefix so that their paths survive the move upstream.
 */
async function vendorLocal(manifest) {
  const plugin = (manifest.plugins || []).find((p) => p.repo === "galaxy-skills");
  if (!plugin?.upstream?.commit) {
    throw new Error(`${VENDOR_MANIFEST} has no galaxy-skills plugin`);
  }
  // A transform would make these bytes differ from the commit the stamp names.
  if (plugin.transforms?.length) {
    throw new Error(
      `${plugin.plugin} is transformed on the way in; refusing to stamp it as upstream`,
    );
  }
  const repo = upstreamRepo(plugin.upstream.repository);
  const sha = plugin.upstream.commit;
  const prefix = `${plugin.as}/`;
  const files = (manifest.files || []).filter((f) => f.plugin === plugin.plugin);
  if (!files.length || files.some((f) => !f.target.startsWith(prefix))) {
    throw new Error(`${VENDOR_MANIFEST} lists no files for ${plugin.plugin} under ${prefix}`);
  }
  const lock = { repo, ref: plugin.upstream.ref, sha };
  let relock = false;
  const existing = await readJson(LOCK);
  // CI builds before it checks, so a rewrite here would hide a stale committed lock.
  if (process.env.CI && (existing?.repo !== repo || existing?.sha !== sha)) {
    throw new Error(
      `core/skills.lock.json pins ${existing?.repo}@${existing?.sha}, but Orbit vendors ` +
        `${repo}@${sha}; rebuild locally and commit the rewritten lock`,
    );
  }
  if (!process.env.CI && JSON.stringify(existing) !== JSON.stringify(lock)) {
    relock = true;
  }
  console.log(
    `[skills] copying ${files.length} files of ${repo}@${sha.slice(0, 8)} from ` +
      `${manifest.repo}@${manifest.commit.slice(0, 8)}'s vendor tree`,
  );

  await rm(DEST, { recursive: true, force: true });
  await mkdir(DEST, { recursive: true });

  let skills = 0;
  const ids = {};
  for (const f of files) {
    const rel = f.target.slice(prefix.length);
    const target = join(DEST, rel);
    if (!target.startsWith(DEST + sep)) {
      throw new Error(`refusing path outside the corpus dir: ${f.target}`);
    }
    const content = await readFile(join(VENDOR, f.target));
    // npm run check:skills holds the tree to these hashes; holding the copy to them too means a
    // dirty vendor tree fails here rather than shipping.
    if (createHash("sha256").update(content).digest("hex") !== f.sha256) {
      throw new Error(`${f.target} does not match ${VENDOR_MANIFEST}; run npm run check:skills`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    ids[rel] = blobSha(content);
    if (rel.endsWith("SKILL.md")) {
      skills += 1;
    }
  }

  await writeFile(
    STAMP,
    JSON.stringify(
      {
        repo,
        ref: sha,
        sha,
        files: files.length,
        skills,
        blobs: ids,
        via: { repo: manifest.repo, commit: manifest.commit },
      },
      null,
      2,
    ) + "\n",
  );
  if (relock) {
    await writeFile(LOCK, JSON.stringify(lock, null, 2) + "\n");
    console.log(`[skills] pinned skills.lock.json to ${sha.slice(0, 8)}`);
  }
  console.log(`[skills] vendored ${skills} skills (${files.length} files) at ${sha.slice(0, 8)}`);
}

async function main() {
  const override = process.env.GALAXY_SKILLS_REPO || process.env.GALAXY_SKILLS_REF;
  if (!override && existsSync(VENDOR_MANIFEST)) {
    await vendorLocal(JSON.parse(await readFile(VENDOR_MANIFEST, "utf-8")));
    return;
  }

  if (!REPO.startsWith(`${ALLOWED_OWNER}/`)) {
    throw new Error(
      `Refusing to vendor "${REPO}": skill content is treated as authoritative agent ` +
        `instructions, so only github.com/${ALLOWED_OWNER}/* is allowed.`,
    );
  }

  const { ref, source } = await resolveRef();
  const sha = await resolveSha(ref);
  const stamp = await readJson(STAMP);
  if (stamp && stamp.sha === sha) {
    console.log(`[skills] galaxy-skills already vendored at ${sha.slice(0, 8)} (${source})`);
    await writeLock(sha, ref);
    return;
  }

  const blobs = await listBlobs(sha);
  console.log(`[skills] vendoring ${blobs.length} files from ${REPO}@${sha.slice(0, 8)}`);

  await rm(DEST, { recursive: true, force: true });
  await mkdir(DEST, { recursive: true });

  let skills = 0;
  for (const blob of blobs) {
    const target = join(DEST, localPath(blob.path));
    // A path escaping DEST would write anywhere on the build machine.
    if (!target.startsWith(DEST + sep)) {
      throw new Error(`refusing path outside the corpus dir: ${blob.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await download(sha, blob));
    if (localPath(blob.path).endsWith("SKILL.md")) {
      skills += 1;
    }
  }

  // Per-file blob ids let scripts/check_vendored.py catch an edit made after vendoring.
  const ids = Object.fromEntries(blobs.map((b) => [localPath(b.path), b.sha]));
  await writeFile(
    STAMP,
    JSON.stringify({ repo: REPO, ref, sha, files: blobs.length, skills, blobs: ids }, null, 2) +
      "\n",
  );
  await writeLock(sha, ref);
  console.log(`[skills] vendored ${skills} skills (${blobs.length} files) at ${sha.slice(0, 8)}`);
}

async function writeLock(sha, ref) {
  const existing = await readJson(LOCK);
  if (existing?.sha === sha && existing?.repo === REPO) {
    return;
  }
  await writeFile(LOCK, JSON.stringify({ repo: REPO, ref, sha }, null, 2) + "\n");
  console.log(`[skills] pinned skills.lock.json to ${sha.slice(0, 8)}`);
}

main().catch((err) => {
  console.error(`[skills] ${err.message}`);
  process.exit(1);
});
