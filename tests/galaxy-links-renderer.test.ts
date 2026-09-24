// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "../app/src/renderer/chat/markdown.js";
import { ChatPanel } from "../app/src/renderer/chat/chat-panel.js";
import { ArtifactPanel } from "../app/src/renderer/artifacts/artifact-panel.js";
import { linkGalaxyArtifacts } from "../app/src/renderer/chat/galaxy-links.js";
import {
  renderGalaxyPageBlock,
  findGalaxyPageBlocks,
} from "../extensions/loom/galaxy-page-binding.js";
import { renderInvocationYaml } from "../extensions/loom/notebook-writer.js";
import { renderJobYaml } from "../extensions/loom/galaxy-job-block.js";
import { refreshGalaxyInvocations } from "../app/src/renderer/galaxy-invocations.js";

vi.hoisted(() => {
  // happy-dom 20's Node.prototype.nodeName getter returns "" on Elements.
  // DOMPurify 3.4 caches that native getter to resist DOM clobbering; browsers
  // return the actual name. Supply the browser semantics in this fixture,
  // keeping the real sanitizer (including its XSS checks) under test.
  const native = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName")!;
  Object.defineProperty(Node.prototype, "nodeName", {
    ...native,
    get() {
      let proto = Object.getPrototypeOf(this);
      while (proto && proto !== Node.prototype) {
        const getter = Object.getOwnPropertyDescriptor(proto, "nodeName")?.get;
        if (getter) return getter.call(this);
        proto = Object.getPrototypeOf(proto);
      }
      return native.get!.call(this);
    },
  });
});

const server = "https://usegalaxy.org";
const pageId = "0123456789abcdef";
const historyId = "0123456789abcdeffedcba9876543210";
const revisionId = "abcdef0123456789";
const binding = {
  pageId,
  historyId,
  galaxyServerUrl: server,
  pageSlug: null,
  lastSyncedRevision: revisionId,
  boundAt: "2026-09-23T18:18:00.000Z",
};
const block = renderGalaxyPageBlock(binding);

function render(text: string, fallback?: string): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(text, undefined, fallback);
  return el;
}
afterEach(() => {
  document.body.innerHTML = "";
});

describe("clickable Galaxy references in rendered Markdown", () => {
  it("links the reported page-binding format while preserving YAML text and parsing", () => {
    const el = render(block);
    expect([...el.querySelectorAll("a")].map((a) => a.href)).toEqual([
      `${server}/published/page?id=${pageId}`,
      server + "/",
      `${server}/histories/view?id=${historyId}`,
      `${server}/api/pages/${pageId}/revisions/${revisionId}`,
    ]);
    expect(el.querySelector("code")?.textContent?.trimEnd()).toBe(
      block.split("\n").slice(1, -2).join("\n"),
    );
    expect(findGalaxyPageBlocks(block)).toEqual([binding]);
    for (const a of el.querySelectorAll("a")) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
    }
    expect(el.querySelector('a[title*="revision"]')?.title).toContain("JSON");
  });

  it("links a nonempty slug to its page and doesn't infer a slug URL without an owner", () => {
    const el = render(renderGalaxyPageBlock({ ...binding, pageSlug: "my-analysis" }));
    expect([...el.querySelectorAll("a")].find((a) => a.textContent === "my-analysis")?.href).toBe(
      `${server}/published/page?id=${pageId}`,
    );
  });

  it("resolves each notebook block on its own server with no ambiguous fallback", () => {
    const el = render(
      block +
        "\n" +
        renderGalaxyPageBlock({ ...binding, galaxyServerUrl: "https://second.example/galaxy" }) +
        `\nDataset ${pageId}`,
    );
    expect(el.querySelectorAll("a")).toHaveLength(8);
    expect(el.querySelector("p a")).toBeNull();
    expect([...el.querySelectorAll("a")][4].href).toBe(
      `https://second.example/galaxy/published/page?id=${pageId}`,
    );
  });

  it("links prose across inline code and emphasis without duplicating existing links", () => {
    const el = render(
      `**Dataset ID:** \`${pageId}\`. [History ${historyId}](${server}/histories/view?id=${historyId})`,
      server,
    );
    expect(el.querySelectorAll("a")).toHaveLength(2);
    expect(el.querySelector("code a")?.textContent).toBe(pageId);
    const before = el.innerHTML;
    linkGalaxyArtifacts(el, server);
    expect(el.innerHTML).toBe(before);
  });

  it("links explicit Galaxy URLs in inline code without a connected server", () => {
    const url = `${server}/datasets/${pageId}`;
    const el = render(`Output: \`${url}\` and [existing](${url}).`);
    expect(el.querySelectorAll("a")).toHaveLength(2);
    expect(el.querySelector("code a")?.getAttribute("href")).toBe(url);
  });

  it("leaves executable fences, nested code examples, malformed metadata and unsafe HTML alone", () => {
    const el = render(
      `- Example:\n\n  \`\`\`python\n  dataset_id = "${pageId}"\n  \`\`\`\n\n\`\`\`markdown\n${block}\n\`\`\`\n\n<img src=x onerror=alert(1)><script>alert(1)</script>\n\n[evil](javascript:alert(1))`,
      server,
    );
    expect(el.querySelector("code a")).toBeNull();
    expect(el.querySelector("script, [onerror], a[href^='javascript:']")).toBeNull();
    expect(
      render(
        `\`\`\`loom-galaxy-page\ngalaxy_server_url: javascript:alert(1)\npage_id: ${pageId}\n\`\`\``,
        server,
      ).querySelector("a"),
    ).toBeNull();
  });

  it("renders invocation/job IDs on their recorded server", () => {
    const common = {
      galaxyServerUrl: server,
      notebookAnchor: "step-1",
      label: "Evaluation",
      submittedAt: binding.boundAt,
      status: "in_progress" as const,
    };
    const text =
      renderInvocationYaml({ ...common, invocationId: pageId }) +
      "\n" +
      renderJobYaml({ ...common, jobId: historyId });
    const el = render(text);
    expect(el.querySelector(`a[href='${server}/workflows/invocations/${pageId}']`)).not.toBeNull();
    expect(el.querySelector(`a[href='${server}/jobs/${historyId}/view']`)).not.toBeNull();
  });
});

describe("actual notebook and chat panels", () => {
  it("renders links in the notebook and retains relative image/link handling", () => {
    document.body.innerHTML =
      '<div id="artifact-tabs"><button class="pane-tab" data-tab="notebook"></button><button class="pane-tab" data-tab="file"></button></div><div id="notebook-view"></div><div id="activity-view"></div><div id="file-view"></div>';
    const panel = new ArtifactPanel();
    panel.setNotebookMarkdown(block + "\n![plot](plot.png)\n[report](report.html)");
    expect(document.querySelectorAll("#notebook-view a.galaxy-artifact-link")).toHaveLength(4);
    expect(document.querySelector("img")?.src).toBe("orbit-artifact://cwd/plot.png");
    expect(document.querySelector('a[href="orbit-artifact://cwd/report.html"]')).not.toBeNull();
    panel.reRenderNotebook();
    expect(document.querySelectorAll("#notebook-view a.galaxy-artifact-link")).toHaveLength(4);
  });

  it("pins live chat to the message's server and does not guess during historical replay", () => {
    const el = document.createElement("div");
    document.body.append(el);
    const chat = new ChatPanel(el);
    chat.setGalaxyServerUrl(server);
    chat.startAssistantMessage();
    chat.appendDelta(`Dataset ID: \`${pageId.slice(0, 8)}`);
    chat.setGalaxyServerUrl("https://second.example/galaxy");
    chat.appendDelta(`${pageId.slice(8)}\``);
    chat.finishAssistantMessage();
    chat.startAssistantMessage();
    chat.appendDelta(`history_id: ${historyId}`);
    chat.finishAssistantMessage();
    chat.startAssistantMessage(null);
    chat.appendDelta(`dataset_id: ${pageId}`);
    chat.finishAssistantMessage();
    expect([...el.querySelectorAll("a")].map((a) => a.href)).toEqual([
      `${server}/datasets/${pageId}`,
      `https://second.example/galaxy/histories/view?id=${historyId}`,
    ]);
    // Original assistant text remains the export source, with no YAML mutation.
    expect(chat.exportAsMarkdown()).toContain(`Dataset ID: \`${pageId}\``);
  });

  it("links metadata in tool results, status messages, and plan cards", () => {
    const el = document.createElement("div");
    document.body.append(el);
    const chat = new ChatPanel(el);
    chat.setGalaxyServerUrl(server);
    chat.addToolCard("call-1", "galaxy_get_dataset_details");
    chat.updateToolCard("call-1", "done", JSON.stringify({ dataset_id: pageId }));
    chat.addInfoMessage(`Job ${historyId} finished`);
    chat.addErrorMessage(`Job ${historyId} failed`);
    chat.startAssistantMessage();
    chat.appendDelta(`\`\`\`plan\nUse dataset ${pageId}\n\`\`\``);
    chat.finishAssistantMessage();
    expect(el.querySelectorAll("a.galaxy-artifact-link")).toHaveLength(4);
  });

  it("makes tracked Activity invocation labels clickable", async () => {
    document.body.innerHTML =
      '<div id="activity-galaxy-section"><span id="galaxy-invocations-count"></span><div id="galaxy-invocations-body"></div></div>';
    const text = renderInvocationYaml({
      invocationId: pageId,
      galaxyServerUrl: server,
      notebookAnchor: "step-1",
      label: "Evaluation",
      submittedAt: binding.boundAt,
      status: "in_progress",
    });
    await refreshGalaxyInvocations({
      readFile: async () => ({ ok: true, bytes: new TextEncoder().encode(text) }),
    });
    expect(document.querySelector<HTMLAnchorElement>(".galaxy-invocation-label")?.href).toBe(
      `${server}/workflows/invocations/${pageId}`,
    );
  });
});
