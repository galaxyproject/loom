/**
 * The agent's internals a flavor's tests reach for: the runtime and its stored documents, the
 * outcomes a tool result carries, artifact placement and the page check, the boundary every flavor
 * keeps to, a Galaxy client, the provider registry, and a scripted model. None is an extension
 * point, so a flavor's own source imports `/agent` instead.
 */
export { resolveArtifacts } from "./agent/artifacts";
export { Binding } from "./agent/documents";
export { hanging, json, stream, text, toolCall } from "./agent/fake-model";
export { connectGalaxy, connectWeb } from "./agent/galaxy";
export { CORE_PACKAGE, flavorTrespasses, specifiers, trespass } from "./flavor-boundary";
export { noteTag } from "./agent/brand";
export { pageContentProblem } from "../../../shared/galaxy-page-cells.js";
export { PROVIDERS } from "./agent/providers";
export {
  artifactsIn,
  context,
  Runtime,
  type RuntimeConfig,
  type RuntimeOptions,
} from "./agent/runtime";
export { usageTotals } from "./agent/saved";
export { claim, Outcome, rendered } from "./agent/tool";
