/**
 * The page backend of the record store: a Galaxy page is the record. The
 * browser shell installs one with `setRecordStore` and supplies the transport
 * (galaxy-api.ts) it talks through; nothing here touches Node.
 *
 * Galaxy's page PUT has no precondition, so the compare-and-swap is a GET,
 * a hash compare and a PUT: the same stat-then-rename window the file backend
 * has, closed in-process by `withRecordLock` exactly as there.
 *
 * Galaxy refuses a page carrying a ``` fence its parser has no cell for, so the
 * record's typed blocks go up as the adapter's hidden carriers and come back as
 * fences on read. The version is the hash of the page as Galaxy stores it, which
 * is what the model's own `update_page` compares against.
 *
 * Decoding on read means a carrier someone writes onto the page in Galaxy comes
 * back as a block the brain acts on, the same trust a hand edit of notebook.md
 * gets on the desktop: the page is the record.
 */

import { getPage, updatePage, type GalaxyPage } from "./galaxy-pages-api";
import { galaxyMarkdownToOrbit, orbitToGalaxyMarkdown } from "./galaxy-markdown-adapter";
import { pageContentHash } from "../../shared/page-content-hash.js";
import {
  EMPTY_RECORD_VERSION,
  NotebookChangedError,
  type RecordStore,
  type RecordVersion,
} from "./record-store";

/** `content` is the embed-expanded render; `content_editor` is the source the agent edits. */
const body = (page: GalaxyPage): string => page.content_editor || page.content || "";

export function createPageRecordStore(opts: {
  key: string;
  /** The page that is the record, when the conversation already has one. */
  pageId?: string;
  /**
   * Make (or find) the conversation's page on its first write, returning its id. Without it an
   * unbound store refuses that write.
   */
  create?: () => Promise<string>;
  /** Make the binding durable; the content goes up only once this resolves. */
  bind?: (pageId: string) => Promise<void>;
  label?: string;
}): RecordStore {
  const { key } = opts;
  let pageId = opts.pageId;
  // Every record writer holds withRecordLock(key), but a stray unlocked one still mustn't make
  // a second page.
  let creating: Promise<string> | null = null;
  // A page create() made whose binding didn't land: the next write binds it rather than
  // making another.
  let unbound: string | undefined;
  const subscribers = new Set<(content: string) => void>();

  async function stat(): Promise<RecordVersion | null> {
    if (pageId === undefined) return EMPTY_RECORD_VERSION;
    try {
      return pageContentHash(body(await getPage(pageId)));
    } catch {
      return null;
    }
  }

  /** The page to write to, and whether this call is the one that brought it into being. */
  async function boundPage(): Promise<{ target: string; made: boolean }> {
    if (pageId !== undefined) return { target: pageId, made: false };
    if (!opts.create) throw new Error(`No Galaxy page is bound to ${key}`);
    const create = opts.create;
    if (creating) return { target: await creating, made: false };
    creating = (async () => {
      unbound ??= await create();
      await opts.bind?.(unbound);
      pageId = unbound;
      unbound = undefined;
      return pageId;
    })().finally(() => {
      creating = null;
    });
    return { target: await creating, made: true };
  }

  return {
    kind: "page",
    key,
    get label() {
      return (
        opts.label ??
        (pageId === undefined ? "Galaxy page (not created yet)" : `Galaxy page ${pageId}`)
      );
    },
    get pageId() {
      return pageId;
    },
    stat,

    async read() {
      if (pageId === undefined) return { content: "", version: EMPTY_RECORD_VERSION };
      const stored = body(await getPage(pageId));
      return { content: galaxyMarkdownToOrbit(stored), version: pageContentHash(stored) };
    },

    async write(content, expect) {
      if (pageId === undefined) {
        if (expect !== undefined && expect !== EMPTY_RECORD_VERSION) {
          throw new NotebookChangedError(key);
        }
        // Nothing to keep, so nothing to make a page for.
        if (content === "") return;
      } else if (expect !== undefined) {
        // A version taken before the page existed can't describe the page that exists now.
        const current = await stat();
        if (current === null || current !== expect) throw new NotebookChangedError(key);
      }
      const { target, made } = await boundPage();
      // Another writer made the page while this one waited, so a version taken from the empty
      // record no longer describes it.
      if (!made && expect === EMPTY_RECORD_VERSION) throw new NotebookChangedError(key);
      await updatePage(target, {
        content: orbitToGalaxyMarkdown(content),
        content_format: "markdown",
        edit_source: "agent",
      });
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

    // A page comes into being on the first write with something in it, never on ensure.
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
