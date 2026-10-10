"""The vendored skills corpus must stay as galaxy-skills has it.

Orbit's chat UI used to be vendored here too, under src/orbit; it is now imported from
app/src/renderer in the same repo, so there is no copy left to drift.
"""

import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

# The skills corpus is gitignored and fetched by scripts/install_skills.js, which stamps each
# file's git blob id. Recomputing them catches an edit made after vendoring.
SKILLS = ROOT / "src" / "agent" / "skills" / "galaxy-skills"
SKILLS_STAMP = SKILLS / "VENDORED.json"


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
        print("skills corpus not vendored; run: node scripts/install_skills.js")
        return 0
    stamp = json.loads(SKILLS_STAMP.read_text())
    pinned = stamp.get("blobs") or {}
    if not pinned:
        print("skills corpus predates blob stamping; re-vendor with: node scripts/install_skills.js")
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
        "  node scripts/install_skills.js"
    )
    return 1


def main(argv: list[str]) -> int:
    return skills(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
