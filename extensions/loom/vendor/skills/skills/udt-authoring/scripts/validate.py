#!/usr/bin/env python3
"""Validate and lint a Galaxy User-Defined Tool (UDT) offline.

Runs the same checks Galaxy runs on the server -- the ``UserToolSource`` schema
(structure + the four semantic validators) and ``lint_user_tool_source`` -- without
needing a live Galaxy. Use it as a fast pre-submit gate before create_user_tool.

Requirements:
    pip install 'galaxy-tool-util>=26.1' pyyaml   # 26.1+ for --check-container

Usage:
    python validate.py my-tool.yml
    python validate.py -                      # read YAML/JSON from stdin
    python validate.py my-tool.yml --check-container   # also verify the container tag on quay.io

Exit codes:
    0  valid and lint-clean (and, with --check-container, the image is built or unverifiable)
    1  schema validation failed
    2  lint findings, or --check-container found the image is positively absent
    3  missing dependency or unreadable input
"""

import sys

try:
    import yaml
except ImportError:
    print("Missing dependency: pip install pyyaml", file=sys.stderr)
    sys.exit(3)

try:
    from galaxy.tool_util_models import UserToolSource, format_validation_errors
    from galaxy.tool_util.lint import lint_user_tool_source
except ImportError:
    print("Missing dependency: pip install 'galaxy-tool-util>=26.1'", file=sys.stderr)
    sys.exit(3)

from pydantic import ValidationError


def _check_container(image):
    """Check whether ``image`` is actually built on quay.io. Returns an exit code.

    Uses the mulled-recommend helper added in Galaxy 26.1; if the installed
    galaxy-tool-util predates it, say so and don't fail the run.
    """
    try:
        from galaxy.tool_util.deps.mulled.recommend import biocontainer_tag_built
    except ImportError:
        print(
            "--check-container needs a galaxy-tool-util with mulled-recommend (Galaxy 26.1+); "
            "skipping the image check.",
            file=sys.stderr,
        )
        return 0

    built = biocontainer_tag_built(image)
    if built is True:
        print(f"Container OK: {image} is built on quay.io.")
        return 0
    if built is False:
        print(f"Container MISSING: {image} is not built on quay.io -- the job would fail with 'manifest unknown'.")
        return 2
    print(f"Container UNVERIFIED: could not check {image} (non-biocontainer reference or transient error).")
    return 0


def main(argv):
    args = argv[1:]
    check_container = "--check-container" in args
    args = [a for a in args if a != "--check-container"]
    if len(args) != 1:
        sys.exit(__doc__)

    source = args[0]
    try:
        if source == "-":
            text = sys.stdin.read()
        else:
            with open(source) as fh:
                text = fh.read()
    except OSError as exc:
        print(f"Cannot read {source}: {exc}", file=sys.stderr)
        return 3
    data = yaml.safe_load(text)

    try:
        tool = UserToolSource.model_validate(data)
    except ValidationError as exc:
        print("Schema validation FAILED:")
        for bullet in format_validation_errors(exc):
            print(f"  - {bullet}")
        return 1

    findings = lint_user_tool_source(tool)
    if findings:
        print("Lint findings (server create would reject these):")
        for bullet in findings:
            print(f"  - {bullet}")
        return 2

    print(f"OK: '{tool.name}' is valid and lint-clean.")
    if check_container:
        return _check_container(tool.container)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
