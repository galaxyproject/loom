import { describe, expect, it } from "vitest";
import {
  buildVerificationDisciplineBlock,
  setupContextInjection,
} from "../extensions/loom/context";

describe("buildVerificationDisciplineBlock", () => {
  it("requires evidence before done claims for checkable artifacts", () => {
    const ctx = buildVerificationDisciplineBlock();

    expect(ctx).toContain("Evidence comes before assertion");
    expect(ctx).toContain('do **not** say "done"');
    expect(ctx).toContain("created but not verified");
    expect(ctx).toContain("Match the verification check to the artifact or action");
    expect(ctx).toContain("Authored Galaxy workflow");
    expect(ctx).toContain("upload/import it to Galaxy");
    expect(ctx).toContain("Galaxy dataset or collection output");
    expect(ctx).toContain("Local data file");
    expect(ctx).toContain("Config, script, or report");
    expect(ctx).toContain("Every new plan step should include a concrete `Verification:`");
    expect(ctx).toContain("infer the appropriate check");
    expect(ctx).toContain("Use a targeted check");
    expect(ctx).not.toContain("Use the cheapest check");
    expect(ctx).toContain("samtools quickcheck");
    expect(ctx).toContain("VCF/BCF");
    expect(ctx).toContain("required keys/columns");
    expect(ctx).toContain("element count");
  });

  it("warns against coercing missing values when filtering significance tables", () => {
    const ctx = buildVerificationDisciplineBlock();
    // Normalize whitespace so these load-bearing phrases survive prose reflow.
    const flat = ctx.replace(/\s+/g, " ");

    expect(flat).toContain("Filtering significance tables — never coerce missing values");
    expect(flat).toContain('`"NA"+0` is `0`');
    expect(flat).toContain("$7+0 < 0.05");
    expect(flat).toContain('writes `NA` in `padj`');
    expect(flat).toContain('awk \'$7 != "NA" && $7+0 < 0.05\'');
    // The awk example must flag its own limitation (it only catches literal NA).
    expect(flat).toContain("only excludes the literal `NA`");
    expect(flat).toContain('dropna(subset=["padj"])');
    expect(flat).toContain("Legitimate numeric filtering is fine");
    expect(flat).toContain("zero-imputation convention is the user's call");
    expect(flat).toContain("sanity-check the surviving row count");
  });

  it("is wired into the assembled system prompt", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers.set(event, handler);
      },
    };

    setupContextInjection(pi as any);
    const result = (await handlers.get("before_agent_start")!({}, {})) as { systemPrompt: string };

    expect(result.systemPrompt).toContain("## Operating discipline");
    expect(result.systemPrompt).toContain("## Verification before completion");
    expect(result.systemPrompt).toContain("## Project model and plan sections");
    expect(result.systemPrompt.indexOf("## Operating discipline")).toBeLessThan(
      result.systemPrompt.indexOf("## Verification before completion"),
    );
    expect(result.systemPrompt.indexOf("## Verification before completion")).toBeLessThan(
      result.systemPrompt.indexOf("## Project model and plan sections"),
    );
  });
});
