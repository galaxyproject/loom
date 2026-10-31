import { vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setGalaxyTransport } from "../extensions/orbit/galaxy-api";
import { createGalaxyOpsToolSource } from "../extensions/orbit/galaxy-ops-tools";
import type { GalaxyTool } from "../extensions/orbit/galaxy-tool-source";
import type { GalaxyToolFamily } from "../shared/galaxy-tool-family.js";
import { GALAXY } from "./galaxy-family-fixture";

export const CREDENTIALS = () => ({ url: "https://galaxy.test", apiKey: "k" });

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One tool of the default galaxy-ops source, bridges included. */
export const opsTool = (name: string): GalaxyTool =>
  createGalaxyOpsToolSource()
    .tools()
    .find((t) => t.name === name)!;

export const runOp = (name: string, params: object, signal?: AbortSignal) =>
  opsTool(name).execute("call-1", params, signal, undefined, {} as never);

export interface SeenRequest {
  method: string;
  path: string;
  search: string;
  query: URLSearchParams;
  body?: Record<string, unknown>;
}

/**
 * Installs a Galaxy transport answering from `reply` and returns every request it saw.
 * /api/version answers nothing and is not recorded, so no version is known and none refuses.
 */
export function recordGalaxy(
  reply: (req: SeenRequest) => Response | Promise<Response> = () => json({}),
): SeenRequest[] {
  const seen: SeenRequest[] = [];
  setGalaxyTransport({
    credentials: CREDENTIALS,
    fetch: async (url, init) => {
      const { pathname: path, search, searchParams: query } = new URL(url);
      if (path === "/api/version") return json({});
      // As a real fetch does: an aborted request never reaches the server.
      if (init.signal?.aborted) throw init.signal.reason;
      // galaxy-ops sends bytes; the brain's own galaxy-api calls (pages, for one) send a string.
      const raw =
        typeof init.body === "string"
          ? init.body
          : init.body
            ? new TextDecoder().decode(init.body as ArrayBuffer)
            : undefined;
      const req: SeenRequest = {
        method: init.method ?? "GET",
        path,
        search,
        query,
        ...(raw ? { body: JSON.parse(raw) as Record<string, unknown> } : {}),
      };
      seen.push(req);
      return reply(req);
    },
  });
  return seen;
}

/**
 * Registers a guard on a stand-in pi and fires its handlers the way pi does: the first handler
 * registered for an event, with `ctx` unless a call passes its own.
 */
export function guardHooks(
  register: (pi: ExtensionAPI, family: GalaxyToolFamily) => void,
  family: GalaxyToolFamily = GALAXY,
  ctx?: unknown,
) {
  const on = vi.fn();
  register({ on } as unknown as ExtensionAPI, family);
  return (name: string, event: unknown, eventCtx: unknown = ctx) =>
    on.mock.calls.find(([key]) => key === name)![1](event, eventCtx);
}

/** A family that spells every Galaxy tool its own way, so text that skips the family shows. */
export const SPELLED: GalaxyToolFamily = {
  tool: (tool) => `gx_${tool}`,
  toolName: (toolName) => (toolName?.startsWith("gx_") ? toolName.slice(3) : undefined),
};
