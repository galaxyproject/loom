/**
 * What a flavor adds to the agent: its brand, its tools, its own skills, its notes on Galaxy
 * results, its prompt sections and its artifact kinds. Each reaches Orbit's brain through the
 * worker (orbit/worker.ts): the tools through the adapter, the notes and sections as layers.
 */
import type { ArtifactKind } from "../artifacts/kinds";
import type { Brand } from "./brand";
import type { AgentTool, Context } from "./tool";

/** What a flavor adds to a Galaxy result before the model reads it, or undefined for nothing. */
export type Annotate = (
  name: string,
  args: Record<string, unknown>,
  data: unknown,
  ctx: Context,
) => Promise<string | undefined>;

export interface AgentFlavor {
  /** Who the agent is and what it keeps things under; DEFAULT_BRAND when the flavor names none. */
  brand?: Brand;
  /** The flavor's own tools, registered after Orbit's; they may place `{{artifact}}` tokens. */
  tools?: () => AgentTool[];
  /** Raw files keyed "./skills/own/<skill>/<path>", offered beside Orbit's shipped skills. */
  skills?: Record<string, string>;
  /** Notes on Galaxy results, appended after Orbit's own handlers have run. */
  annotators?: Annotate[];
  /** System prompt sections: right after the identity line, as terms, or after Orbit's prompt. */
  promptSections?: (input: { model?: string; provider?: string; datasetId?: string }) => {
    afterIdentity?: string[];
    /** Bullets for the flavor's own terms, for things only its tools act on. */
    terminology?: string[];
    afterRouter?: string[];
  };
  /** Registered in whichever realm the runtime runs in. */
  artifactKinds?: readonly ArtifactKind<any>[];
}
