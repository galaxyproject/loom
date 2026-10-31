/**
 * Orbit's brain (extensions/orbit) installed in the agent worker: the seams it reads instead of a
 * Node host, set once per worker (or per Headless session) before the brain registers, then the
 * brain itself on pi-host.
 *
 * Order matters: the env shim comes first (Orbit reads process at import), the profile before the
 * brain registers (registration reads it), and every seam before session_start.
 */
import "./env";

import loom from "../../../../../extensions/orbit/index";
import { setGalaxyTransport } from "../../../../../extensions/orbit/galaxy-api";
import {
  createGalaxyOpsToolSource,
  type GalaxyExtra,
} from "../../../../../extensions/orbit/galaxy-ops-tools";
import { setPollWake } from "../../../../../extensions/orbit/galaxy-reconcile";
import {
  setGalaxyToolSource,
  type GalaxyTool,
} from "../../../../../extensions/orbit/galaxy-tool-source";
import {
  setSubmissionLedger,
  type SubmissionLedger,
} from "../../../../../extensions/orbit/submission-ledger";
import { setInstructionSource } from "../../../../../extensions/orbit/user-instructions";
import { setRecordStore } from "../../../../../extensions/orbit/record-store";
import { setVendorSkillsSource } from "../../../../../extensions/orbit/vendor-skills";
import { setCapabilityProfile } from "../../../../../shared/capability-profile.js";
import { setConfigSource } from "../../../../../shared/config-source.js";
import { defineExtension, type AnyTask, type Extension } from "@earendil-works/pi-durable";
import { createPiHost, type PiHost, type PiHostOptions, type PiHostUi } from "../pi-host";
import { orbitGrant } from "./grants";
import {
  registerBrowserLayers,
  registerFlavorLayers,
  type FlavorLayerHost,
  type LayerHost,
} from "./layers";
import { vendorSkills, type OwnSkillFile, type SkillReader } from "./skills";

/** What the model is told to ask for when Galaxy refuses the page's sign-in. */
export const WORKER_AUTH_REMEDY =
  "Ask the user to sign in to Galaxy again in this browser (their Galaxy session has likely expired)";

/**
 * Orbit's settings that would reach for something a worker has no way to show or no use for:
 * lesson nudges send a custom message pi-host refuses, observations in "ask" mode open dialogs
 * the worker can't render, and team dispatch runs subprocesses.
 */
const WORKER_CONFIG = {
  lessons: { enabled: false },
  observations: { mode: "off" as const },
  experiments: { teamDispatch: false, autoResume: false },
};

export interface OrbitBootOptions {
  /** The page's capability grant; one Orbit can't map refuses the boot. */
  capabilities: readonly string[];
  /** Galaxy as the worker reaches it: the browser transport and the absolute root. */
  galaxy: { fetch: typeof fetch; url: string; key?: string };
  ledger: SubmissionLedger;
  /** The secrets Orbit's redactor scrubs that aren't in its config: the active model's key. */
  secrets: () => string[];
  ui: Required<Pick<PiHostUi, "ask" | "notify">>;
  /** Extras the Galaxy tool source registers beside the ops entry's operations. */
  extras?: GalaxyExtra[];
  /** The shell's own tools (run_python, the processes), registered after the brain's. */
  shellTools?: GalaxyTool[];
  /** What the browser layers read; without it none are registered. */
  layers?: LayerHost;
  /** A flavor's prompt sections and result notes, registered after the browser layers. */
  flavorLayers?: FlavorLayerHost;
  /** A flavor's own skills, offered beside the vendored ones. */
  ownSkills?: OwnSkillFile[];
  /** How a shipped skill body is read, where fetching it beside the bundle won't do (Node). */
  readSkill?: SkillReader;
  /** The browser shell's durable tasks: the watch. */
  tasks?: AnyTask[];
  /** What a reconcile that saw a run end wakes instead of polling: the bound conversation's watch. */
  pollWake?: () => void;
  host?: Pick<PiHostOptions, "models" | "beforeStart" | "onLateCompletion" | "afterExecute">;
}

export interface OrbitBoot {
  host: PiHost;
  /** Orbit's sealed extension and the browser's own shell extension, for the registry. */
  extensions: Extension[];
}

let booted = false;

/**
 * Orbit's process-wide seams for the worker: the profile from the grant (refusing one Orbit can't
 * map), the config, instructions, skills, Galaxy transport, ledger, poll wake and tool source.
 */
export function installOrbitSeams(
  options: Pick<
    OrbitBootOptions,
    | "capabilities"
    | "galaxy"
    | "ledger"
    | "secrets"
    | "extras"
    | "ownSkills"
    | "readSkill"
    | "pollWake"
  >,
): void {
  const grant = orbitGrant(options.capabilities);
  setCapabilityProfile({
    shell: false,
    files: false,
    notebook: "page",
    // Means a CORS-limited fetch here; nothing reads it.
    network: true,
    mcpServers: false,
    ui: "worker",
    python: grant.python,
    galaxy: grant.galaxy,
    authRemedy: WORKER_AUTH_REMEDY,
  });
  setConfigSource({ load: () => structuredClone(WORKER_CONFIG), secrets: options.secrets });
  // The page has no standing instructions file to hand over yet.
  setInstructionSource({ files: () => [] });
  setVendorSkillsSource(vendorSkills(options.ownSkills, options.readSkill));
  setGalaxyTransport({
    fetch: options.galaxy.fetch,
    // getGalaxyConfig needs a key to call Galaxy connected. Without a dev key the page's cookie
    // authenticates: the placeholder is never sent (the browser transport sets x-api-key only
    // from its own key) and is too short for the redactor to scrub.
    credentials: () => ({ url: options.galaxy.url, apiKey: options.galaxy.key ?? "cookie" }),
  });
  setSubmissionLedger(options.ledger);
  // Nothing polls outside the durable watch: a reconcile that saw a run end wakes it.
  setPollWake(options.pollWake ?? (() => {}));
  setGalaxyToolSource(createGalaxyOpsToolSource({ extras: options.extras ?? [] }));
}

/** The ask bridge a worker host gets: only confirm has a dialog in the page. */
export const workerUi = (ui: OrbitBootOptions["ui"]): PiHostUi => ({
  ...ui,
  supports: ["confirm"],
});

/**
 * Register Orbit's brain on `host`, then the shell's tools and layers after it, so Orbit's guards
 * decide first.
 */
export function registerOrbit(
  host: PiHost,
  options: Pick<OrbitBootOptions, "shellTools" | "layers" | "flavorLayers">,
): void {
  loom(host.api);
  for (const tool of options.shellTools ?? []) host.api.registerTool(tool);
  if (options.layers) registerBrowserLayers(host.api, options.layers);
  if (options.flavorLayers) registerFlavorLayers(host.api, options.flavorLayers);
}

/** Seal the host's registrations beside the browser shell's own extension and its tasks. */
export function sealOrbit(host: PiHost, tasks: AnyTask[] = []): Extension[] {
  return [host.seal(), defineExtension({ name: "browser-shell", tasks })];
}

/**
 * Undo what bootOrbit installed, so another boot can follow in the same process: Node hosts one
 * session after another (Headless); a browser worker boots once and never needs this.
 */
export function closeOrbit(): void {
  setCapabilityProfile(null);
  setConfigSource(null);
  setInstructionSource(null);
  setVendorSkillsSource(null);
  setGalaxyTransport(null);
  setSubmissionLedger(null);
  setPollWake(null);
  setGalaxyToolSource(null);
  setRecordStore(null);
  booted = false;
}

/** Install Orbit's seams and register the brain. Once per worker: the seams are process-wide. */
export function bootOrbit(options: OrbitBootOptions): OrbitBoot {
  if (booted) throw new Error("Orbit's brain is already booted in this worker");
  installOrbitSeams(options);
  booted = true;
  const host = createPiHost({
    name: "orbit",
    cwd: "/orbit",
    // What the shim couldn't do: a production worker has no other place to say so.
    onNote: (note) => {
      if (note.kind === "handler-error" || note.kind === "busy") console.warn("[orbit]", note);
    },
    ui: workerUi(options.ui),
    ...options.host,
  });
  registerOrbit(host, options);
  return { host, extensions: sealOrbit(host, options.tasks) };
}
