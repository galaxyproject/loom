/**
 * What the brain leaves out under the browser worker (slice 3, commit 8): the page-sync tools and
 * /sync under a page record, which is already the page, /connect under ui: "worker", which is
 * signed in by the Galaxy page around it (and /profiles with it); and the auth remedy the model is given in its place.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AUTH_REMEDY,
  profileFromEnv,
  setCapabilityProfile,
  type CapabilityProfile,
} from "../shared/capability-profile.js";
import { galaxyRecoveryHint } from "../extensions/orbit/galaxy-recovery";
import { setGalaxyToolSource } from "../extensions/orbit/galaxy-tool-source";
import { GALAXY } from "./galaxy-family-fixture";

const SYNC_TOOLS = [
  "notebook_link_galaxy_page",
  "notebook_list_galaxy_pages",
  "notebook_pull_from_galaxy",
  "notebook_push_to_galaxy",
  "notebook_resume_from_galaxy",
];

/** Every tool and command the brain registers under `profile`. */
async function boot(profile: Partial<CapabilityProfile>) {
  setCapabilityProfile({ ...profileFromEnv({}), ui: "desktop", ...profile });
  const tools: string[] = [];
  const commands: string[] = [];
  const noop = () => undefined;
  const pi = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "registerTool") return (def: { name: string }) => tools.push(def.name);
        if (prop === "registerCommand") return (name: string) => commands.push(name);
        if (prop === "getAllTools" || prop === "getActiveTools") return () => [];
        if (prop === "events") return { on: noop, emit: noop };
        return noop;
      },
    },
  );
  const mod = await import("../extensions/orbit/index");
  mod.default(pi as never);
  return { tools: new Set(tools), commands: new Set(commands) };
}

afterEach(() => {
  setCapabilityProfile(null);
  setGalaxyToolSource(null);
});

describe("registration under the worker's profile", () => {
  it("keeps sync and /connect on the desktop", async () => {
    const { tools, commands } = await boot({});
    for (const name of SYNC_TOOLS) expect(tools, name).toContain(name);
    expect(commands).toContain("sync");
    expect(commands).toContain("connect");
    expect(commands).toContain("profiles");
  });

  it("drops the page-sync tools and /sync under a page record, and nothing else", async () => {
    const desktop = await boot({});
    const page = await boot({ notebook: "page" });
    expect([...desktop.tools].filter((n) => !page.tools.has(n)).sort()).toEqual(SYNC_TOOLS);
    expect([...desktop.commands].filter((n) => !page.commands.has(n))).toEqual(["sync"]);
  });

  it("drops /connect and /profiles under ui: worker", async () => {
    const desktop = await boot({ notebook: "page" });
    const worker = await boot({ notebook: "page", ui: "worker" });
    // /dashboard was already off there: the worker has no pane to show a dashboard in.
    expect([...desktop.commands].filter((n) => !worker.commands.has(n)).sort()).toEqual([
      "connect",
      "dashboard",
      "profiles",
    ]);
  });
});

describe("the auth remedy", () => {
  const authHint = () => galaxyRecoveryHint("get_histories", "auth", GALAXY);

  it("is /connect unless the shell says otherwise", () => {
    expect(authHint()).toContain(`${DEFAULT_AUTH_REMEDY}; do not retry until they have.`);
    setCapabilityProfile({
      ...profileFromEnv({}),
      ui: "worker",
      authRemedy: "Ask the user to sign in to Galaxy again",
    });
    expect(authHint()).toContain(
      "Ask the user to sign in to Galaxy again; do not retry until they have.",
    );
    expect(authHint()).not.toContain("/connect");
  });
});
