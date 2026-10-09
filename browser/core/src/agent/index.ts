/**
 * The agent a flavor extends, as the browser runs it. Node-only parts (Headless, describe,
 * runNodeSession) are under `@galaxyproject/orbit-browser/node`, the worker entry under `/worker`,
 * and the internals only tests reach for under `/testing`.
 */
export type { Artifact, ArtifactOf } from "../artifacts/kinds";
export { DEFAULT_BRAND, type Brand } from "./brand";
export { query, segment, type Galaxy, type Web } from "./galaxy";
export { normalizeGalaxyLinkServer } from "../../../../shared/galaxy-artifact-links.js";
export type { Annotate } from "./ops";
export { quote } from "./quote";
export { isSessionDocument, SCHEMA, type SessionDocument } from "./saved";
export * as tables from "./tables";
export { fail, type Capability, type Context, type AgentTool, type Python } from "./tool";
export type { AgentFlavor } from "./tools";
