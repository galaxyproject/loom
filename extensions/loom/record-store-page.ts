/**
 * The page backend of the record store: a Galaxy page is the record. The
 * browser shell installs one with `setRecordStore` and supplies the transport
 * (galaxy-api.ts) it talks through; nothing here touches Node.
 *
 * Galaxy's page PUT has no precondition, so the compare-and-swap is a GET,
 * a hash compare and a PUT: the same stat-then-rename window the file backend
 * has, closed in-process by `withRecordLock` exactly as there.
 */

import { getPage, updatePage, type GalaxyPage } from "./galaxy-pages-api";
import { pageContentHash } from "../../shared/page-content-hash.js";
import { NotebookChangedError, type RecordStore, type RecordVersion } from "./record-store";

/** `content` is the embed-expanded render; `content_editor` is the source the agent edits. */
const body = (page: GalaxyPage): string => page.content_editor || page.content || "";

export function createPageRecordStore(opts: {
  key: string;
  pageId: string;
  label?: string;
}): RecordStore {
  const { key, pageId } = opts;
  const subscribers = new Set<(content: string) => void>();

  async function stat(): Promise<RecordVersion | null> {
    try {
      return pageContentHash(body(await getPage(pageId)));
    } catch {
      return null;
    }
  }

  return {
    kind: "page",
    key,
    label: opts.label ?? `Galaxy page ${pageId}`,
    pageId,
    stat,

    async read() {
      const content = body(await getPage(pageId));
      return { content, version: pageContentHash(content) };
    },

    async write(content, expect) {
      if (expect !== undefined) {
        const current = await stat();
        if (current === null || current !== expect) throw new NotebookChangedError(key);
      }
      await updatePage(pageId, { content, content_format: "markdown", edit_source: "agent" });
      // Own writes are the whole feed here: chokidar reports Orbit's own file
      // writes on the desktop, and the subscribers (widget, proposal drift,
      // auto-push) expect to see a poller write right away. Out-of-band page
      // edits are caught by the after-tool reemit in state.ts.
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(content);
        } catch (err) {
          console.error("record change listener failed:", err);
        }
      }
    },

    // The shell binds the store to an existing page; the store never creates one.
    async ensure() {
      return false;
    },

    onChange(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
}
