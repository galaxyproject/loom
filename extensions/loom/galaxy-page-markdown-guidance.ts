import { galaxyMcpTool } from "../../shared/galaxy-mcp-tools.js";
import { galaxyPageMarkdown } from "../../shared/prompt-blocks.js";

/**
 * How to author content destined for a Galaxy page. The text is shared with the browser shell
 * (shared/prompt-blocks.js): Galaxy's client splits a page at every ``` line and renders only
 * its own cell types, and current Galaxy refuses a page with any other fence, so the author is
 * steered toward ~~~ for code. The push adapter (galaxy-markdown-adapter.ts) only rewrites
 * Loom's own typed fences; everything else in notebook.md reaches the page verbatim.
 *
 * Shared by the notebook_push_to_galaxy tool description (covers the first push, before any
 * binding block exists) and the live page-binding context block.
 */
export const GALAXY_PAGE_MARKDOWN_GUIDANCE = galaxyPageMarkdown({ tool: galaxyMcpTool });
