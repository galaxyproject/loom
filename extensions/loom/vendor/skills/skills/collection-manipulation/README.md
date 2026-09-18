# Collection Manipulation Skill

Transform Galaxy dataset collections reproducibly using Galaxy's native collection operation tools.

## What This Skill Does

Guides AI agents through Galaxy collection transformations—filtering, sorting, relabeling, restructuring, merging, flattening, nesting, and more—while ensuring all operations use Galaxy's native tools for reproducibility and workflow compatibility.

Covers 20+ collection operation tools and the Apply Rules DSL for complex transformations.

## Attribution

Based on [jmchilton/galaxy-agentic-collection-transform](https://github.com/jmchilton/galaxy-agentic-collection-transform) by John Chilton.

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Main slash command — decision framework, API patterns, pitfalls, examples |
| `references/tools.md` | 26 collection operation tools catalog |
| `references/apply-rules.md` | Apply Rules DSL deep-dive |
| `references/api-patterns.md` | Galaxy Tools API patterns |
| `references/test-patterns.md` | Real test patterns from Galaxy test suite |

## Usage

```
/galaxy-transform-collection <describe what you want to do with your collection>
```

Examples:
- `/galaxy-transform-collection remove control samples from my list collection`
- `/galaxy-transform-collection convert my flat list into list:paired using R1/R2 filename patterns`
- `/galaxy-transform-collection group samples by treatment condition using tags`

## Prerequisites

- Galaxy MCP server configured (preferred), OR
- Direct Galaxy API access with API key
