/**
 * galaxy-ops' get_page and update_page, widened with what galaxy-ops' next release gives them
 * (#155's S6): a `content_hash` on every page read and written, an `expect_hash` that refuses a
 * write to a page that changed since it was read, section edits by heading line, and a refusal
 * of directive ids that are not encoded ids. Delete this module when galaxy-ops ships S6.
 *
 * Only that operation behaviour lives here. What the brain adds on top -- remembering the page it
 * showed the model, repairing a stale hash when the section is untouched, serializing with the
 * record poller -- is policy (galaxy-op-policy.ts), so it survives this module's deletion.
 *
 * Writes go to Galaxy directly through the operation's context, never through
 * `recordStore.write()`: the model is editing a Galaxy page, which may or may not be the record,
 * and the record store's own version check is the policy's business, not the operation's.
 */
import {
  getPageOp,
  GalaxyValidationError,
  httpError,
  updatePageOp,
  type AnyOperation,
  type InputOf,
  type Operation,
  type PageDetail,
} from "@galaxyproject/galaxy-ops";
import { applySectionEdit } from "../../shared/markdown-sections.js";
import { malformedObjectIds } from "../../shared/malformed-object-ids.js";
import { pageContentHash } from "../../shared/page-content-hash.js";
import type { GalaxyBridge } from "./galaxy-ops-tools";

interface PageBody {
  content_editor?: string | null;
  content?: string | null;
}

/** The editable markdown, as galaxy-ops' contentHash reads it: the hash is taken over this. */
export function pageBody(page: PageBody): string {
  return page.content_editor || page.content || "";
}

function withoutRendered<T extends PageBody>(page: T): Omit<T, "content"> {
  const { content: _rendered, ...rest } = page;
  return rest;
}

/** The refusal for directive ids that are not encoded ids; create_page's policy says the same. */
export function malformedIdsRefusal(found: readonly string[]): string {
  return `These Galaxy directive arguments do not hold an encoded id: ${found.join(", ")}. Galaxy has nothing to look up behind them, so the embed comes out empty. Copy the object's id from a Galaxy tool's answer instead (get_history_contents gives every dataset and collection in a history with its id).`;
}

type WithHash<T> = T & { content_hash: string };

// Neither page op is budgeted, and a budget typed over the base op's output would not fit the
// bridge's, so the bridges start from the rest of each op.
const { budget: _getPageBudget, ...getPageBase } = getPageOp;
const { budget: _updatePageBudget, ...updatePageBase } = updatePageOp;

const getPageBridgeOp: Operation<typeof getPageOp.input, WithHash<Omit<PageDetail, "content">>> = {
  ...getPageBase,
  async run(i, ctx) {
    // One GET for both: galaxy-ops strips the rendered body unless asked for it, and the hash
    // has to be taken over the raw page the server sent.
    const raw = await getPageOp.run({ ...i, includeRendered: true }, ctx);
    const content_hash = pageContentHash(pageBody(raw));
    return { ...(i.includeRendered ? raw : withoutRendered(raw)), content_hash };
  },
};

export const getPageBridge: GalaxyBridge = {
  op: getPageBridgeOp as unknown as AnyOperation,
  note: "Also returns content_hash, a hash of that markdown. Hand it back to update_page as expect_hash and the update only lands while the page still reads as it did for you.",
};

// Derived from update_page's own fields, so the three render and parse through galaxy-ops' zod
// and carry the same types the next galaxy-ops gives them; only the words are Orbit's.
const updatePageInput = {
  ...updatePageOp.input,
  sectionHeading: updatePageOp.input.title.describe(
    "Heading line of the section to rewrite, exactly as the page has it (for example '## Results'). Every section under that heading line is rewritten. Markdown pages only; send section_content with it and leave content out.",
  ),
  sectionContent: updatePageOp.input.content.describe(
    "Everything the section should hold, its heading line first. When the page has no section under that heading, this goes on the end.",
  ),
  expectHash: updatePageOp.input.content.describe(
    "The content_hash get_page gave you. If the page has been edited after that, nothing is written and you are told to read it again.",
  ),
};

type UpdatePageInput = InputOf<typeof updatePageInput>;

function refusal(i: UpdatePageInput): string | undefined {
  const section = i.sectionHeading != null || i.sectionContent != null;
  if (section && (i.sectionHeading == null || i.sectionContent == null)) {
    return "section_heading and section_content are a pair: give both to rewrite one section.";
  }
  if (section && i.content != null) {
    return "Give content to replace the whole page, or section_heading with section_content to rewrite one section -- not both.";
  }
  const found = malformedObjectIds(section ? i.sectionContent : i.content);
  return found.length > 0 ? malformedIdsRefusal(found) : undefined;
}

const updatePageBridgeOp: Operation<
  typeof updatePageInput,
  WithHash<Omit<PageDetail, "content">>
> = {
  ...updatePageBase,
  input: updatePageInput,
  async run(i, ctx) {
    const refused = refusal(i);
    if (refused) throw new GalaxyValidationError(refused);
    let content = i.content;
    if (i.sectionHeading != null || i.expectHash != null) {
      const { data, error, response } = await ctx.client.GET("/api/pages/{id}", {
        params: { path: { id: i.pageId } },
      });
      if (error || !data) throw httpError(response, error);
      const actual = pageContentHash(pageBody(data));
      if (i.expectHash != null && i.expectHash !== actual) {
        throw new GalaxyValidationError(
          `Page '${i.pageId}' changed since it was read: its content_hash is now ${actual}, not ${i.expectHash}. Read it again with get_page and make the edit against what is there now.`,
        );
      }
      if (i.sectionHeading != null) {
        if (data.content_format !== "markdown") {
          throw new GalaxyValidationError(
            `Page '${i.pageId}' is written in ${data.content_format}, and only a markdown page can have one section rewritten. Send the whole content instead.`,
          );
        }
        content = applySectionEdit(pageBody(data), i.sectionHeading, i.sectionContent ?? "");
      }
      // The read can outlive the deadline on a transport that ignores its signal; by then the
      // caller has reported an unknown result and released the record lock, so the write must
      // not go out.
      ctx.signal?.throwIfAborted();
    }
    // No content_format: a page keeps the format it was written in, as galaxy-ops' own
    // update_page leaves it. galaxy-pages-api's updatePage always sends one, which would
    // relabel an HTML page as markdown.
    const body: { edit_source: string; content?: string; title?: string } = {
      edit_source: "agent",
    };
    if (content != null) body.content = content;
    if (i.title != null) body.title = i.title;
    const { data, error, response } = await ctx.client.PUT("/api/pages/{id}", {
      params: { path: { id: i.pageId } },
      body,
    });
    if (error || !data) throw httpError(response, error);
    const written = data as PageDetail;
    return { ...withoutRendered(written), content_hash: pageContentHash(pageBody(written)) };
  },
};

export const updatePageBridge: GalaxyBridge = {
  op: updatePageBridgeOp as unknown as AnyOperation,
  note: "To rewrite one section rather than the whole page, send section_heading and section_content instead of content. With expect_hash set to the content_hash get_page gave you, nothing is written if someone has edited the page in between. The reply carries the written page and its new content_hash.",
};
