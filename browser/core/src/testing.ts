/**
 * The agent's internals a flavor's tests reach for: the runtime and its stored documents, the
 * guards and outcomes a tool result carries, the placement and page checks, the boundary every flavor keeps to, how the tool list and
 * skills are put together, a Galaxy client, the provider registry, and a scripted model.
 * None is an extension point, so a flavor's own source imports `/agent` instead.
 */
export { resolveArtifacts } from "./agent/artifacts";
export { Binding } from "./agent/documents";
export { hanging, json, stream, text, toolCall } from "./agent/fake-model";
export { connectGalaxy, connectWeb } from "./agent/galaxy";
export { CORE_PACKAGE, flavorTrespasses, specifiers, trespass } from "./flavor-boundary";
export { annotating } from "./agent/galaxy-tools";
export { noteTag } from "./agent/brand";
export { pageContentProblem } from "./agent/page-edit";
export { PROVIDERS } from "./agent/providers";
export {
  artifactsIn,
  context,
  drawnEvents,
  Runtime,
  type RuntimeConfig,
  type RuntimeOptions,
} from "./agent/runtime";
export { usageTotals } from "./agent/saved";
export { flavoredSkills } from "./agent/skills";
export { claim, GUARDS, Outcome, rendered } from "./agent/tool";
export { agentTools } from "./agent/tools";
export { ChatView } from "./transcript";
