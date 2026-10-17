"""The vendored skills corpus must stay as galaxy-skills has it.

Orbit's chat UI used to be vendored here too, under src/orbit; it is now imported from
app/src/renderer in the same repo, so there is no copy left to drift.
"""

import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

# The skills corpus is gitignored and vendored by core/scripts/install_skills.js, which stamps each
# file's git blob id. Recomputing them catches an edit made after vendoring.
SKILLS = ROOT / "core" / "src" / "agent" / "skills" / "galaxy-skills"
SKILLS_STAMP = SKILLS / "VENDORED.json"
SKILLS_LOCK = ROOT / "core" / "skills.lock.json"
# Orbit's vendor tree, which the install copies from when browser/ sits in the loom repo.
ORBIT_MANIFEST = ROOT.parent / "extensions" / "loom" / "vendor" / "skills" / "_manifest.json"


def blob_id(path: pathlib.Path) -> str:
    """The id git gives a blob, which is what the vendor stamp records."""
    data = path.read_bytes()
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def skills(argv: list[str]) -> int:
    """Compare the vendored skills corpus against the blob ids its install stamped."""
    if not SKILLS_STAMP.exists():
        print("skills corpus not vendored; run: node core/scripts/install_skills.js")
        return 0
    stamp = json.loads(SKILLS_STAMP.read_text())
    pinned = stamp.get("blobs") or {}
    if not pinned:
        print("skills corpus predates blob stamping; re-vendor with: node core/scripts/install_skills.js")
        return 0

    present = {str(p.relative_to(SKILLS)): p for p in SKILLS.rglob("*") if p.is_file() and p != SKILLS_STAMP}
    changed = sorted(r for r, want in pinned.items() if r in present and blob_id(present[r]) != want)
    missing = sorted(r for r in pinned if r not in present)
    extra = sorted(r for r in present if r not in pinned)
    if not (changed or missing or extra):
        print(f"{len(pinned)} vendored skill files unchanged at {stamp.get('sha', '?')[:8]}")
        return 0

    for r in changed:
        print(f"  MODIFIED  skills/galaxy-skills/{r}")
    for r in missing:
        print(f"  MISSING   skills/galaxy-skills/{r}")
    for r in extra:
        print(f"  EXTRA     skills/galaxy-skills/{r}")
    print(
        f"\n{stamp.get('repo', 'galaxy-skills')} owns this corpus and olit vendors it verbatim.\n"
        "A formatter or an editor reaching into it diverges from upstream and is undone by the\n"
        "next vendor. Restore it with:\n"
        "  node core/scripts/install_skills.js"
    )
    return 1


def lock(argv: list[str]) -> int:
    """The lock must pin the galaxy-skills commit Orbit's vendor tree carries, so one manifest
    bump moves both shells and neither can drift onto a revision of its own."""
    if not ORBIT_MANIFEST.exists():
        print("no Orbit vendor manifest beside browser/; skills.lock.json is pinned on its own")
        return 0
    manifest = json.loads(ORBIT_MANIFEST.read_text())
    plugin = next((p for p in manifest.get("plugins") or [] if p.get("as") == "skills"), None)
    if plugin is None:
        print(f'{ORBIT_MANIFEST} has no plugin vendored as "skills"')
        return 1
    upstream = plugin.get("upstream") or {}
    repo = upstream.get("repository", "").removeprefix("https://github.com/").rstrip("/").removesuffix(".git")
    want = upstream.get("commit")
    if not want:
        print(f'{ORBIT_MANIFEST} names no upstream commit for the plugin vendored as "skills"')
        return 1
    pinned = json.loads(SKILLS_LOCK.read_text())
    if pinned.get("sha") == want and pinned.get("repo") == repo:
        print(f"skills.lock.json matches Orbit's vendored {repo}@{want[:8]}")
        return 0
    print(
        f"core/skills.lock.json pins {pinned.get('repo')}@{pinned.get('sha')}, but Orbit vendors\n"
        f"{repo}@{want} through {manifest.get('repo')}@{manifest.get('commit', '?')[:8]}.\n"
        "Move the pin through scripts/skills.manifest.json at the repo root (npm run sync:skills),\n"
        "then re-vendor with: node core/scripts/install_skills.js"
    )
    return 1


def main(argv: list[str]) -> int:
    return lock(argv) | skills(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
