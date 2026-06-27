/** Per-provider credentials + preferred model. */
export interface LlmProviderConfig {
  /** Plaintext API key. Orbit migrates this to apiKeyEncrypted on startup. */
  apiKey?: string;
  /** Base64 ciphertext produced by Electron safeStorage. Orbit-only. */
  apiKeyEncrypted?: string;
  model?: string;
  /**
   * Base URL for an OpenAI-compatible endpoint (e.g. Jetstream, vLLM, Ollama).
   * Presence marks this entry as a custom provider: the brain registers it in
   * ~/.pi/agent/models.json and supplies the key at runtime via --api-key.
   */
  baseUrl?: string;
}

export interface LoomConfig {
  /**
   * Opaque beta-tester code (e.g. "orbit-007"). When set, it rides along on
   * feedback submissions so the team can attribute reports to a tester. Not a
   * secret and not PII -- the code<->identity map lives outside the app. Also
   * settable per-session via the LOOM_TESTER_ID env var.
   */
  testerId?: string;
  llm?: {
    /** Name of the currently-active provider, e.g. "anthropic". */
    active: string;
    /** One entry per configured provider. */
    providers: Record<string, LlmProviderConfig>;
  };
  galaxy?: {
    active: string | null;
    profiles: Record<
      string,
      {
        url: string;
        /** Plaintext API key. Orbit migrates to apiKeyEncrypted on startup. */
        apiKey?: string;
        /** Base64 ciphertext produced by Electron safeStorage. Orbit-only. */
        apiKeyEncrypted?: string;
      }
    >;
  };
  defaultCwd?: string;
  /** When false, all update checks (CLI notice + Orbit auto-update/banner) are disabled. Default true. */
  updateCheck?: boolean;
  /**
   * Execution mode gate. Independent of whether Galaxy credentials are
   * configured.
   * - \`cloud\` (default): agent decides per-plan whether each step runs
   *   locally or on Galaxy. Plan routing tags (\`[local]\`/\`[hybrid]\`/\`[remote]\`)
   *   describe the resulting mix.
   * - \`local\`: project is sandboxed to local execution. The agent must not
   *   propose Galaxy steps even if Galaxy MCP is registered.
   */
  executionMode?: "local" | "cloud";
  /**
   * Skill repositories. Each entry points at a GitHub repo following the
   * Claude-Code skills convention (top-level AGENTS.md router + nested
   * SKILL.md files). The agent fetches them on demand via the
   * \`skills_fetch\` tool. The list is seeded with \`galaxy-skills\` if
   * absent. Set \`enabled: false\` to keep an entry without using it.
   */
  skills?: {
    repos: Array<SkillRepo>;
  };
  /**
   * Opt-in flags for experimental subsystems. Off by default; set the
   * matching env var (e.g. LOOM_TEAM_DISPATCH=1) to override per-session.
   */
  experiments?: {
    /** Register the experimental team_dispatch tool and its prompt guidance. */
    teamDispatch?: boolean;
    /**
     * Register the experimental session-index tools (chat_search,
     * chat_session_context, chat_find_tool_calls) that query Pi's JSONL
     * session corpus via a SQLite+FTS5 mirror at ~/.loom/sessions-index.db.
     */
    sessionIndex?: boolean;
  };
  /**
   * Terminal/display preferences for the loom CLI.
   */
  ui?: {
    /**
     * Orbit visual theme. Missing or invalid values resolve to "dark" so
     * existing installs keep the pre-theme appearance.
     */
    theme?: "light" | "dark";
    /**
     * Show the model's "thinking" blocks in the interactive terminal. Off by
     * default -- loom hides them (writes pi's `hideThinkingBlock`) to keep the
     * chat readable. Set true to restore pi's reasoning stream persistently.
     * For a one-off, pi's built-in Ctrl+T toggles thinking live in-session.
     * Terminal-only: Orbit and headless (--print) launches don't touch it.
     */
    showThinking?: boolean;
  };
  /**
   * Local-execution safety gate (exec-guard). Secure by default: the gate is
   * enabled, never bypassed, and trusts nothing until the user says otherwise.
   */
  guardian?: {
    /** Master switch. When false the gate is fully off (advanced escape hatch). */
    enabled?: boolean;
    /**
     * Turn the gate into a pass-through (allow everything). Human-only: the
     * agent can never set this, because writing ~/.loom/config.json is itself
     * gated. Also settable via --dangerously-bypass-permissions / env.
     */
    dangerouslyBypassPermissions?: boolean;
    /** Project dirs the user has chosen to trust (relaxes routine-bash prompts). */
    trustedWorkspaces?: string[];
    /** Extra absolute roots treated as inside the workspace jail. */
    extraWorkspaceRoots?: string[];
    /** Record of the one-time local-execution consent. */
    consentAcknowledged?: { version: string; at: string } | null;
    /**
     * Opt-in bash sandbox: run allowed bash inside an OS sandbox (sandbox-exec /
     * bubblewrap) so bash writes are confined to the workspace and its network is
     * limited. Off by default (it restricts bash network); also settable via
     * --sandbox / LOOM_SANDBOX. File-tool writes are confined by the gate regardless.
     */
    sandbox?: boolean;
  };
}

export interface SkillRepo {
  /** Stable identifier used by the agent in \`skills_fetch({ repo: "..." })\`. */
  name: string;
  /** GitHub repo URL, e.g. \`https://github.com/galaxyproject/galaxy-skills\`. */
  url: string;
  /** Branch / ref to fetch from. Defaults to \`main\`. */
  branch?: string;
  /** When false the repo is kept in config but not advertised to the agent. */
  enabled?: boolean;
}

export function getConfigDir(): string;
export function getConfigPath(): string;
export function loadConfig(): LoomConfig;
export function saveConfig(config: LoomConfig): void;
export const ALLOWED_SKILLS_PREFIX: string;
export function isAllowedSkillUrl(url: string): boolean;
