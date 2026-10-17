/**
 * The Galaxy version observations carry, for the in-process Galaxy tools.
 *
 * galaxy-mcp reported it in its connect result; the in-process tools have no
 * connect, so the version comes from galaxy-ops' own /api/version lookup once
 * per session, and is refreshed whenever the model reads get_server_info.
 * Registered only under bare: under mcp the connect result still supplies it,
 * and a probe there would add a request to every desktop session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GalaxyToolFamily } from "../../shared/galaxy-mcp-tools.js";
import { galaxyOpsContext } from "./galaxy-api";
import { recordGalaxyVersion } from "./observations";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** "26.1" + "1" -> "26.1.1": the release number the connect result used to carry. */
export function versionOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const major = payload.version_major;
  if (typeof major !== "string" || !major) return undefined;
  const minor = payload.version_minor;
  return typeof minor === "string" && minor ? `${major}.${minor}` : major;
}

/** The get_server_info envelope, from structuredContent while it survives, else the text. */
function envelopeOf(structured: unknown, content: ReadonlyArray<{ type: string; text?: string }>) {
  if (isRecord(structured)) return structured;
  const text = content.find((c) => c.type === "text")?.text;
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // A preview or a message, not the envelope: nothing to read a version from.
    return undefined;
  }
}

// A session_start whose lookup finishes after a newer one began (a /connect
// reload, say) must not label the new server with the old one's version.
let generation = 0;

export function registerGalaxyVersionCapture(pi: ExtensionAPI, family: GalaxyToolFamily): void {
  pi.on("session_start", async () => {
    const g = ++generation;
    const ctx = galaxyOpsContext();
    if (!ctx?.galaxyVersion) return;
    // Not awaited: session start must not wait on a Galaxy round trip.
    void ctx
      .galaxyVersion()
      .then((report) => {
        if (g === generation && report.payload) recordGalaxyVersion(versionOf(report.payload));
      })
      .catch(() => {});
  });

  pi.on("tool_result", async (event) => {
    if (event.isError || family.toolName(event.toolName) !== "get_server_info") return;
    const env = envelopeOf(event.structuredContent, event.content);
    const data = env?.data;
    if (isRecord(data)) recordGalaxyVersion(versionOf(data.version));
  });
}
