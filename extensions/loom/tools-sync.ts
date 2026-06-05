/**
 * Tool registrations for Loom <-> Galaxy Pages sync.
 *
 * Thin wrappers around the helpers in galaxy-pages-sync.ts. The helpers do
 * all the work (locking, network, binding-block math); these registrations
 * just translate TypeBox-validated params, call the helper, and format the
 * response for the agent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  pushNotebookToGalaxy,
  pullNotebookFromGalaxy,
  linkGalaxyPage,
  resumeGalaxyPage,
} from "./galaxy-pages-sync";

function errorContent(e: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${e instanceof Error ? e.message : String(e)}`,
      },
    ],
    details: { error: true },
  };
}

export function registerNotebookSyncTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "notebook_push_to_galaxy",
    label: "Push notebook to Galaxy page",
    description: `Push the local notebook.md to a Galaxy page. If the notebook already
has a loom-galaxy-page binding block, updates that page in place (creates a
new revision). If there's no binding yet, pass history_id (and optionally title,
slug, annotation) to create a new page attached to that history and bind it.
Strips loom-galaxy-page blocks from the body sent to Galaxy, but keeps
loom-invocation blocks (they're analysis content). Unconditional local-wins:
any concurrent Galaxy-UI edits since the last sync are overwritten.`,
    parameters: Type.Object({
      history_id: Type.Optional(
        Type.String({
          description: "History ID to attach the page to (required when creating a new page).",
        }),
      ),
      title: Type.Optional(
        Type.String({
          description: "Page title for create. Defaults to 'Untitled notebook' if omitted.",
        }),
      ),
      slug: Type.Optional(
        Type.String({
          description:
            "URL slug for create. Lowercase letters, digits, and hyphens. Auto-generated if omitted.",
        }),
      ),
      annotation: Type.Optional(
        Type.String({
          description: "Optional annotation attached to the page.",
        }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await pushNotebookToGalaxy({
          historyId: params.history_id,
          title: params.title,
          slug: params.slug,
          annotation: params.annotation,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  page_id: result.pageId,
                  page_slug: result.pageSlug,
                  latest_revision_id: result.latestRevisionId,
                  action: result.action,
                },
                null,
                2,
              ),
            },
          ],
          details: { pageId: result.pageId, action: result.action },
        };
      } catch (e) {
        return errorContent(e);
      }
    },
  });

  pi.registerTool({
    name: "notebook_pull_from_galaxy",
    label: "Pull notebook from Galaxy page",
    description: `Replace the local notebook.md with the body of the linked Galaxy page,
then re-apply the loom-galaxy-page binding block on top. Requires the
notebook to already have a binding (use notebook_link_galaxy_page or
notebook_push_to_galaxy first). Unconditional remote-wins: any local edits
since the last sync are overwritten, including loom-invocation blocks
that weren't pushed yet.`,
    parameters: Type.Object({}),
    async execute(_callId, _params, _signal, _onUpdate, _ctx) {
      try {
        const result = await pullNotebookFromGalaxy();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  page_id: result.pageId,
                  latest_revision_id: result.latestRevisionId,
                },
                null,
                2,
              ),
            },
          ],
          details: { pageId: result.pageId },
        };
      } catch (e) {
        return errorContent(e);
      }
    },
  });

  pi.registerTool({
    name: "notebook_resume_from_galaxy",
    label: "Resume notebook from Galaxy page",
    description: `One-shot resume of a Galaxy page into the local notebook: writes the
loom-galaxy-page binding block and replaces local content with the remote
page body in a single locked operation. Use this when starting a fresh
Loom session against a page that was created or last edited in the Galaxy
UI -- it saves the user from having to do notebook_link_galaxy_page then
notebook_pull_from_galaxy. Refuses to clobber when the notebook is already
bound to a different page on the same server (use notebook_link_galaxy_page
to switch explicitly). Idempotent when re-resuming the same page.`,
    parameters: Type.Object({
      page_id: Type.String({
        description: "Encoded page id (or slug) to resume from.",
      }),
      history_id: Type.Optional(
        Type.String({
          description: "History id; only needed if Galaxy's page response doesn't include one.",
        }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await resumeGalaxyPage(params.page_id, {
          historyId: params.history_id,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  page_id: result.pageId,
                  latest_revision_id: result.latestRevisionId,
                  action: result.action,
                },
                null,
                2,
              ),
            },
          ],
          details: { pageId: result.pageId, action: result.action },
        };
      } catch (e) {
        return errorContent(e);
      }
    },
  });

  pi.registerTool({
    name: "notebook_link_galaxy_page",
    label: "Link notebook to existing Galaxy page",
    description: `Bind the local notebook.md to an existing Galaxy page without pushing
or pulling content. Inserts a loom-galaxy-page block with the page's id,
slug, server URL, and latest revision id. Use this when an analysis was
started in the Galaxy UI and the user wants Loom to take over editing.`,
    parameters: Type.Object({
      page_id: Type.String({
        description: "Encoded page id (or slug) to link to.",
      }),
      history_id: Type.Optional(
        Type.String({
          description: "History id; only needed if Galaxy's page response doesn't include one.",
        }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await linkGalaxyPage(params.page_id, {
          historyId: params.history_id,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  page_id: result.pageId,
                  latest_revision_id: result.latestRevisionId,
                },
                null,
                2,
              ),
            },
          ],
          details: { pageId: result.pageId },
        };
      } catch (e) {
        return errorContent(e);
      }
    },
  });
}
