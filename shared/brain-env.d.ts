export const BRAIN_ENV_PASSTHROUGH: ReadonlySet<string>;
export const BRAIN_ENV_PREFIXES: readonly string[];
export const PROVIDER_API_KEY_NAMES: ReadonlySet<string>;

export interface BuildBrainEnvOptions {
  /** Forward ANTHROPIC_API_KEY / OPENAI_API_KEY / etc. from the source env. */
  includeProviderKeys?: boolean;
}

export function buildBrainEnv(
  sourceEnv?: NodeJS.ProcessEnv,
  opts?: BuildBrainEnvOptions,
): NodeJS.ProcessEnv;
