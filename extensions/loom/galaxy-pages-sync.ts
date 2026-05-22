/**
 * Push / pull / link helpers for Loom <-> Galaxy Page sync.
 *
 * v1 contract (see ./galaxy-page-binding.ts for full notes):
 *  - push is unconditional local-wins
 *  - pull is unconditional remote-wins
 *  - server-URL mismatch throws before any network call
 *  - last_synced_revision is stored, not enforced
 */

import { getNotebookPath } from "./state";
import { getGalaxyConfig, type GalaxyConfig } from "./galaxy-api";
import { readNotebook, writeNotebook, withNotebookLock } from "./notebook-writer";
import { createPage, updatePage, getPage } from "./galaxy-pages-api";
import {
    findGalaxyPageBlocks,
    upsertGalaxyPageBlock,
    stripGalaxyPageBlocks,
    type GalaxyPageBindingYaml,
} from "./galaxy-page-binding";

export interface PushOptions {
    historyId?: string;
    title?: string;
    slug?: string;
    annotation?: string;
}

export interface PushResult {
    pageId: string;
    pageSlug: string | null;
    latestRevisionId: string;
    action: "created" | "updated";
}

function requireNotebookPath(): string {
    const p = getNotebookPath();
    if (!p) throw new Error("notebook path is not set (no active loom session)");
    return p;
}

function requireGalaxyConfig(): GalaxyConfig {
    const c = getGalaxyConfig();
    if (!c) {
        throw new Error(
            "no active Galaxy connection. Use /connect to set a server first.",
        );
    }
    return c;
}

export interface PullResult {
    pageId: string;
    latestRevisionId: string;
}

export async function pullNotebookFromGalaxy(): Promise<PullResult> {
    const nbPath = requireNotebookPath();
    const config = requireGalaxyConfig();

    return withNotebookLock(nbPath, async () => {
        const content = await readNotebook(nbPath);
        const existing = findGalaxyPageBlocks(content)[0];
        if (!existing) {
            throw new Error(
                "notebook is not bound to a Galaxy page. Use notebook_link_galaxy_page " +
                    "to link to an existing page, or notebook_push_to_galaxy to create one.",
            );
        }
        if (existing.galaxyServerUrl !== config.url) {
            throw new Error(
                `Notebook is bound to a Galaxy page on ${existing.galaxyServerUrl}, ` +
                    `but you are connected to ${config.url}. Use /connect to switch first.`,
            );
        }
        const page = await getPage(existing.pageId);
        const remoteBody = page.content ?? "";
        const refreshed: GalaxyPageBindingYaml = {
            ...existing,
            pageSlug: page.slug ?? existing.pageSlug,
            lastSyncedRevision: page.latest_revision_id,
        };
        await writeNotebook(nbPath, upsertGalaxyPageBlock(remoteBody, refreshed));
        return { pageId: existing.pageId, latestRevisionId: page.latest_revision_id };
    });
}

export async function pushNotebookToGalaxy(
    opts: PushOptions = {},
): Promise<PushResult> {
    const nbPath = requireNotebookPath();
    const config = requireGalaxyConfig();

    return withNotebookLock(nbPath, async () => {
        const content = await readNotebook(nbPath);
        const existing = findGalaxyPageBlocks(content)[0];
        const stripped = stripGalaxyPageBlocks(content);

        if (existing) {
            if (existing.galaxyServerUrl !== config.url) {
                throw new Error(
                    `Notebook is bound to a Galaxy page on ${existing.galaxyServerUrl}, ` +
                        `but you are connected to ${config.url}. Use /connect to switch, or ` +
                        `notebook_link_galaxy_page to re-link to a page on the connected server.`,
                );
            }
            const updated = await updatePage(existing.pageId, {
                content: stripped,
                content_format: "markdown",
                edit_source: "agent",
            });
            const refreshed: GalaxyPageBindingYaml = {
                ...existing,
                pageSlug: updated.slug ?? existing.pageSlug,
                lastSyncedRevision: updated.latest_revision_id,
            };
            await writeNotebook(nbPath, upsertGalaxyPageBlock(stripped, refreshed));
            return {
                pageId: existing.pageId,
                pageSlug: refreshed.pageSlug,
                latestRevisionId: updated.latest_revision_id,
                action: "updated",
            };
        }

        if (!opts.historyId) {
            throw new Error(
                "notebook is not bound to a Galaxy page; pass history_id to create one",
            );
        }
        const created = await createPage({
            history_id: opts.historyId,
            title: opts.title ?? "Untitled notebook",
            slug: opts.slug,
            annotation: opts.annotation,
            content: stripped,
            content_format: "markdown",
        });
        const binding: GalaxyPageBindingYaml = {
            pageId: created.id,
            pageSlug: created.slug ?? null,
            galaxyServerUrl: config.url,
            historyId: opts.historyId,
            lastSyncedRevision: created.latest_revision_id,
            boundAt: new Date().toISOString(),
        };
        await writeNotebook(nbPath, upsertGalaxyPageBlock(stripped, binding));
        return {
            pageId: created.id,
            pageSlug: created.slug ?? null,
            latestRevisionId: created.latest_revision_id,
            action: "created",
        };
    });
}
