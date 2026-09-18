# Galaxy Integration Examples

Practical examples for interacting with Galaxy instances using MCP and BioBlend.

---

## Overview

These examples demonstrate **how to use Galaxy MCP and BioBlend** to interact with Galaxy instances. They are **domain-agnostic** and can be applied to any workflow or tool testing scenario.

---

## Examples

### tool-checking.md

**Purpose**: Check tool availability on a Galaxy instance

**Covers**:
- Using Galaxy MCP to search for tools
- Using BioBlend script to validate tool lists
- Decision matrix: when to use MCP vs BioBlend
- Interpreting results

**Use when**: You need to verify tools exist before creating/running workflows

---

### workflow-testing.md

**Purpose**: Test and validate workflows on a Galaxy instance

**Covers**:
- Using Galaxy MCP for interactive workflow testing
- Using BioBlend script for automated workflow validation
- Workflow invocation and monitoring
- Output verification
- Decision matrix: when to use MCP vs BioBlend

**Use when**: You need to test a workflow on a Galaxy instance

---

## When to Use These Examples

### During Conversion (Nextflow → Galaxy)

After converting a Nextflow workflow to Galaxy, use these examples to:
1. Check that all required tools exist (`tool-checking.md`)
2. Test the converted workflow (`workflow-testing.md`)

**See also**: `../../../dev-skills/nf-to-galaxy/examples/` for conversion-specific scenarios

### During Tool Development

After creating or updating a Galaxy tool, use these examples to:
1. Verify tool is available on target instance
2. Test tool in a workflow context

**See also**: `../../../dev-skills/tool-dev/SKILL.md`

### General Workflow Testing

For any Galaxy workflow testing needs:
1. Validate workflow structure
2. Test workflow execution
3. Compare outputs

---

## Prerequisites

### Galaxy MCP

Interactive Galaxy client for exploration and debugging.

**Setup**: See `../galaxy-integration.md` for MCP configuration

**Best for**:
- Interactive exploration
- Debugging workflow issues
- Real-time monitoring
- Complex decision-making

### BioBlend Script

Automated Galaxy tool checker and workflow validator.

**Setup**: See `../scripts/README.md` for script configuration

**Best for**:
- Automated validation
- Batch checking
- CI/CD integration
- Scripted workflows

---

## Related Documentation

- **Main guide**: `../galaxy-integration.md` - Complete Galaxy integration guide
- **MCP setup**: `../galaxy-integration.md#setup`
- **BioBlend script**: `../scripts/README.md` - galaxy_tool_checker.py usage
- **Conversion examples**: `../../../dev-skills/nf-to-galaxy/examples/` - Conversion-specific scenarios
- **Testing guide**: `../../../dev-skills/tool-dev/references/testing.md` - Planemo tool testing

---

## Quick Reference

| Task | MCP | BioBlend Script |
|------|-----|-----------------|
| Check single tool | `search_tools_by_name()` | `--tool-id TOOL_ID` |
| Check tool list | Multiple calls | `--tool-list file.txt` |
| Validate workflow | `import_workflow()` | `--workflow file.ga` |
| Test workflow | `invoke_workflow()` | `--workflow --test` |
| Monitor execution | `get_invocation()` | `--wait` flag |
| Batch operations | Manual iteration | Native support |
| CI/CD integration | Possible but complex | Designed for it |
