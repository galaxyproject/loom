/** @anthropic-ai/sandbox-runtime in the Orbit worker: no shell, no sandbox. */
import { unavailable } from "./unavailable";

const fail = unavailable("@anthropic-ai/sandbox-runtime");

export const SandboxManager = new Proxy(
  {},
  {
    get: (_target, prop) => (typeof prop === "string" ? fail(`SandboxManager.${prop}`) : undefined),
  },
);
