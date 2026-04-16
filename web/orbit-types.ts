// Type-only re-export so the renderer's `import("../preload/preload.js").OrbitAPI`
// resolves when built outside Electron. The actual runtime is orbit-shim.ts.
export type { OrbitAPI } from "../app/src/preload/preload";
