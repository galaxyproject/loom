/**
 * The Orbit seams the hosted workers install, served by worker/bundle.ts as one virtual module.
 * Typed loosely on purpose: the brain's sources typecheck under the root project, and pulling
 * extensions/orbit into this workspace's program would check them under the wrong config.
 */
declare module "orbit-brain" {
  type Seam<T> = (next: T | null) => void;
  export const loom: (pi: unknown) => void;
  export const setCapabilityProfile: Seam<Record<string, unknown>>;
  export const setConfigSource: Seam<{ load: () => unknown; secrets?: () => string[] }>;
  export const setInstructionSource: Seam<{
    files: () => Array<{ scope: string; path: string; content: string; truncated: boolean }>;
  }>;
  export const setVendorSkillsSource: Seam<{
    catalog: unknown;
    manifest: unknown;
    read: (target: string) => string | null;
  }>;
  export const setGalaxyTransport: Seam<{
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    credentials?: () => { url: string; apiKey: string };
  }>;
  export const setRecordStore: Seam<unknown>;
  export const createPageRecordStore: (opts: { key: string; pageId: string }) => unknown;
  export const setGalaxyToolSource: Seam<unknown>;
  export const createGalaxyOpsToolSource: (opts: { extras: unknown[] }) => {
    tools: () => Array<{ name: string }>;
    companions?: () => unknown[];
  };
  export const createMemoryOutputStore: (limits?: { entries?: number; bytes?: number }) => unknown;
  export const setGalaxyOutputStore: Seam<unknown>;
}

/** The vendored skills tree, inlined by worker/bundle.ts. */
declare module "orbit-vendor-skills" {
  export const catalog: unknown;
  export const manifest: { files: Array<{ target: string }> };
  export const files: Record<string, string>;
}
