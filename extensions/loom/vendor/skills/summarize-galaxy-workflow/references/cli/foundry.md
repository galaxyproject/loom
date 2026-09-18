---
type: cli-tool
tool: foundry
origin: npm
package: "@galaxy-foundry/gxwf-foundry"
invoke: foundry
invoke_fallback: "npx --package @galaxy-foundry/gxwf-foundry foundry"
availability_check: "foundry --help"
docs_url: "https://github.com/galaxyproject/foundry/blob/main/packages/gxwf-foundry/README.md"
tags:
  - cli/foundry
status: draft
created: 2026-05-11
revised: 2026-05-11
revision: 1
summary: "Foundry CLI: bundles all Mold IO validators and a summarize-nextflow subcommand."
---

# foundry

Unified Foundry CLI. Subcommands cover every Mold IO validator plus a `summarize-nextflow` wrapper around the standalone `@galaxy-foundry/summarize-nextflow` package. Per-subcommand synopsis, args, and options are rendered from `@galaxy-foundry/gxwf-foundry/meta`.

## Install

`npx --package @galaxy-foundry/gxwf-foundry foundry <subcommand>` runs without a global install. For repeat use, `npm install -g @galaxy-foundry/gxwf-foundry`.
