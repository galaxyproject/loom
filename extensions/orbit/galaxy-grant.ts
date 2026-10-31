/**
 * What a read-only launch (`galaxy: "read"` in the capability profile) withholds. Galaxy's own
 * tools are withheld by their `readOnlyHint` in galaxy-tool-source.ts, which fails closed on a
 * tool that doesn't declare it. Orbit's own tools don't carry the hint, so the ones that write
 * Galaxy or the analysis record are named here instead: a read-only conversation keeps no record,
 * since the record is itself a Galaxy page in the browser.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capabilityProfile } from "../../shared/capability-profile.js";

export function galaxyReadOnly(): boolean {
  return capabilityProfile().galaxy === "read";
}

/** Orbit's tools that write Galaxy or the record. tests/galaxy-grant.test.ts walks the
 *  registered tools, so a new one has to be classified here or in its list of readers. */
export const ORBIT_WRITING_TOOLS: ReadonlySet<string> = new Set([
  "galaxy_upload_local_file",
  "galaxy_job_record",
  "galaxy_invocation_record",
  "galaxy_invocation_check_all",
  "galaxy_invocation_check_one",
  "loom_propose",
  "notebook_push_to_galaxy",
  "notebook_pull_from_galaxy",
  "notebook_link_galaxy_page",
  "notebook_resume_from_galaxy",
]);

/** `pi`, or under a read-only launch a view of it whose registerTool drops Orbit's writers. */
export function withholdingWriters(pi: ExtensionAPI): ExtensionAPI {
  if (!galaxyReadOnly()) return pi;
  return new Proxy(pi, {
    get(target, prop) {
      if (prop === "registerTool") {
        return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
          if (!ORBIT_WRITING_TOOLS.has(tool.name)) target.registerTool(tool);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The prompt's word on it, so the model neither looks for a way to write nor for a notebook. */
export function buildReadOnlyGalaxyBlock(): string {
  if (!galaxyReadOnly()) return "";
  return `## Galaxy access: read-only

This conversation can read Galaxy but not change it: no tool runs, workflow invocations,
uploads, history changes or Galaxy pages. If the user asks for one, say it needs a launch with
write access rather than looking for a way around it. It also keeps no analysis record, so
there is no notebook to read or write; keep findings in your replies.
`;
}
