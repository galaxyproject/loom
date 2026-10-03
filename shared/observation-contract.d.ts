export declare const OBSERVATION_SCHEMA_VERSION: 1;
export declare const OBSERVATIONS_ROUTE: "/observations";
export declare const OBSERVATION_KEY_HEADER: "X-Orbit-Feedback-Key";
export declare const RETRACT_TOKEN_HEADER: "X-Retract-Token";
export declare const OBSERVATIONS_ENDPOINT_URL: string;
export declare const OBSERVATION_MAX_BYTES: number;

export declare const PUBLIC_GALAXY_SERVERS: readonly string[];
export declare const PRIVATE_SERVER: "private";

export type ObservationKind =
  | "tool-error"
  | "retry-loop"
  | "assertion-failed"
  | "user-correction"
  | "silent-wrong-result"
  | "other";
export type ObservationStage =
  | "data-acquisition"
  | "metadata-reconciliation"
  | "tool-parameterization"
  | "job-execution"
  | "result-interpretation"
  | "unknown";
export type ObservationTrigger =
  "tool_error" | "retry_loop" | "assertion" | "user_correction" | "explicit";
export type ObservationApp = "orbit" | "loom-cli";
export type ObservationPlatform = "darwin" | "linux" | "win32";

export declare const OBSERVATION_KINDS: readonly ObservationKind[];
export declare const OBSERVATION_STAGES: readonly ObservationStage[];
export declare const OBSERVATION_TRIGGERS: readonly ObservationTrigger[];
export declare const OBSERVATION_APPS: readonly ObservationApp[];
export declare const OBSERVATION_PLATFORMS: readonly ObservationPlatform[];

export declare const SIGNATURE_MAX: number;
export declare const DESCRIPTION_MAX: number;
export declare const TOOLS_MAX: number;
export declare const TOOL_ID_MAX: number;
export declare const TOOL_VERSION_MAX: number;
export declare const MCP_TOOL_MAX: number;
export declare const DATATYPES_MAX: number;
export declare const DATATYPE_MAX: number;
export declare const VERSION_MAX: number;
export declare const UNKNOWN_SIGNATURE: "unknown";

export interface ObservationToolRef {
  /** Galaxy tool id, version segment split off when the id is a toolshed path. */
  id: string;
  version?: string;
}

export interface Observation {
  schemaVersion: 1;
  /** Client-generated UUID v4. */
  id: string;
  clientTs: string;
  client: {
    app: ObservationApp;
    version: string;
    platform: ObservationPlatform;
    /** Present and true only under WSL; a WSL install reports platform "linux". */
    wsl?: boolean;
  };
  /** 32 lowercase hex, random, generated once per install. */
  installToken: string;
  kind: ObservationKind;
  stage: ObservationStage;
  trigger: ObservationTrigger;
  tools: ObservationToolRef[];
  mcpTool?: string;
  datatypes: string[];
  /** Normalized error/outcome signature; see normalizeSignature. */
  signature: string;
  galaxy: { version?: string; server: string };
  /** Agent- or user-written, generic, validator-checked. May be empty. */
  description: string;
}

export declare function rawSignatureLine(text: unknown): string;
export declare function signatureStageLeaks(text: unknown): string[];
export declare function normalizeSignature(text: unknown): string;
export declare const LEAK_PATTERNS: ReadonlyArray<readonly [string, RegExp]>;
export declare function validateObservation(
  obj: unknown,
): { ok: true } | { ok: false; errors: string[] };
export declare const CLIENT_LEAK_PATTERNS: ReadonlyArray<readonly [string, RegExp]>;
export declare function textLeaks(text: unknown): string[];
export declare function scanObservationForLeaks(obs: unknown): string[];
export declare function capObservation(obs: unknown): Observation;
export declare function observationByteLength(obs: unknown): number;
