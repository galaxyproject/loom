import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import { runTeamDispatch } from "./dispatcher";
import { validateTeamSpec } from "./validate";
import type { DispatchDeps, RoleTurnResult, TeamSpec, RoleSpec } from "./types";
import { TEAM_DISPATCH_KIND } from "../../../shared/team-dispatch-contract.js";
import type { TeamDispatchDetails } from "../../../shared/team-dispatch-contract.js";

const RoleSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  system_prompt: Type.String({ minLength: 1 }),
  model: Type.Optional(Type.String()),
});

const TeamSpecSchema = Type.Object({
  description: Type.String({ minLength: 1 }),
  roles: Type.Array(RoleSchema, { minItems: 2, maxItems: 2 }),
  max_rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  model: Type.Optional(Type.String()),
});

export function registerTeamTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "team_dispatch",
    label: "Dispatch specialist team",
    description:
      "Run a two-role critic loop (proposer → critic) to converge on a result. " +
      "Use when the user asks for a 'team' to handle a bounded sub-task such as " +
      "literature review or cross-checking findings. Each role is a pure-reasoning " +
      "LLM call (no tools); gather any external data with your own tools first and " +
      "include it in the `description`. Returns the converged result; persist useful " +
      "output by editing notebook.md when the researcher wants it retained.",
    parameters: TeamSpecSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const spec = params as TeamSpec;

      // 1. Spec validation (fail fast).
      try {
        validateTeamSpec(spec);
      } catch (err) {
        return errorResult(err);
      }

      // 2. Build the runRoleTurn binding over pi-ai.completeSimple.
      const deps: DispatchDeps = {
        runRoleTurn: async (
          role: RoleSpec,
          preamble,
          userMessage,
          runSignal,
        ): Promise<RoleTurnResult> => {
          const model = resolveModel(ctx, role.model ?? spec.model);
          if (!model) {
            throw new Error(
              `No model available: neither role "${role.name}" nor the team spec nor the session provides one.`,
            );
          }
          const msg = await completeSimple(
            model,
            {
              systemPrompt: preamble,
              messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
            },
            { signal: runSignal },
          );
          const content = extractText(msg);
          // Count cache tokens too so the budget ceiling is honest on
          // providers that charge for cache reads/writes (Anthropic).
          const cacheRead = msg.usage.cacheRead ?? 0;
          const cacheWrite = msg.usage.cacheWrite ?? 0;
          return {
            content,
            usage: {
              input_tokens: msg.usage.input + cacheRead + cacheWrite,
              output_tokens: msg.usage.output,
            },
          };
        },
      };

      // 3. Drive the loop; stream progress to the tool card.
      const abort = signal ?? new AbortController().signal;
      const result = await runTeamDispatch(spec, deps, abort, (snapshot) => {
        const details: TeamDispatchDetails = {
          kind: TEAM_DISPATCH_KIND,
          spec: {
            description: spec.description,
            roles: spec.roles.map((r) => ({ name: r.name, model: r.model ?? spec.model })),
          },
          turns: snapshot.turns,
          summary: `Round ${snapshot.round}/${snapshot.max_rounds} — ${snapshot.current_role} responding…`,
        };
        onUpdate?.({
          content: [],
          details,
        });
      });

      // 4. Final tool-card summary.
      const finalSummary = result.converged
        ? `Team converged in ${result.rounds} round${result.rounds === 1 ? "" : "s"}`
        : result.aborted
          ? `Team aborted after ${result.rounds} round${result.rounds === 1 ? "" : "s"}`
          : result.budget_exhausted
            ? `Team halted on token budget after ${result.rounds} round${result.rounds === 1 ? "" : "s"}`
            : result.error
              ? `Team errored after ${result.rounds} round${result.rounds === 1 ? "" : "s"}: ${result.error}`
              : `Team did not converge (${result.rounds}/${spec.max_rounds ?? 5} rounds — best-so-far returned)`;

      const finalDetails: TeamDispatchDetails = {
        kind: TEAM_DISPATCH_KIND,
        spec: {
          description: spec.description,
          roles: spec.roles.map((r) => ({ name: r.name, model: r.model ?? spec.model })),
        },
        turns: result.transcript,
        summary: finalSummary,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: finalDetails,
      };
    },
    renderResult: (result) => {
      const d = result.details as { summary?: string } | undefined;
      return new Text(d?.summary ?? "team_dispatch finished");
    },
  });
}

// --- helpers ------------------------------------------------------------

/**
 * Resolve a Model<any> from a "provider:modelId" string, a bare Anthropic
 * model id, or by falling back to the session model.
 */
function resolveModel(
  ctx: ExtensionContext,
  modelSpec: string | undefined,
): Model<any> | undefined {
  if (modelSpec && modelSpec.trim().length > 0) {
    const colon = modelSpec.indexOf(":");
    const provider = colon >= 0 ? modelSpec.slice(0, colon) : "anthropic";
    const modelId = colon >= 0 ? modelSpec.slice(colon + 1) : modelSpec;
    const found = ctx.modelRegistry.find(provider, modelId);
    if (!found) {
      throw new Error(
        `Unknown model "${modelSpec}" (provider="${provider}", modelId="${modelId}"). ` +
          `Check ctx.modelRegistry, or omit the model field to use the session default.`,
      );
    }
    return found;
  }
  return ctx.model;
}

/** Flatten an AssistantMessage's text chunks into a single string. */
function extractText(msg: { content: Array<{ type: string; text?: string }> }): string {
  return msg.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const details: TeamDispatchDetails = {
    kind: TEAM_DISPATCH_KIND,
    error: message,
    summary: `team_dispatch failed: ${message}`,
  };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ ok: false, error: message }, null, 2) },
    ],
    details,
  };
}
