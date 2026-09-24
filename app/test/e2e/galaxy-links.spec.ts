/** Real Chromium + shared renderer; no brain, credentials, or Galaxy mutations. */
import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

test("notebook and chat Galaxy links render and open in another tab", async ({ page, context }) => {
  const root = path.resolve(__dirname, "../../..");
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-links-vite-"));
  const notebook =
    '## Galaxy notebook\n\n```loom-galaxy-page\npage_id: 0123456789abcdef\npage_slug:\ngalaxy_server_url: "https://usegalaxy.org"\nhistory_id: 0123456789abcdeffedcba9876543210\nlast_synced_revision: abcdef0123456789\nbound_at: 2026-09-23T18:18:00.000Z\n```';
  const fixture = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app/src/renderer/styles.css"><style>
    body {display:block;padding:24px} main {display:grid;grid-template-columns:1fr 1fr;gap:24px}
    #messages {height:600px} #notebook-view {position:relative;overflow:auto} h1 {font-size:20px;margin-bottom:24px}
    </style></head><body><h1>Orbit · Galaxy artifact links</h1><main><section><h2>Chat</h2><div id="messages"></div></section><section>
    <div id="artifact-tabs"><button class="pane-tab active" data-tab="notebook">Notebook</button><button class="pane-tab" data-tab="file" hidden>File</button></div>
    <div id="notebook-view"></div><div id="activity-view" class="hidden"></div><div id="file-view" class="hidden"></div></section></main>
    <script type="module">
    import {ChatPanel} from '/app/src/renderer/chat/chat-panel.ts';
    import {ArtifactPanel} from '/app/src/renderer/artifacts/artifact-panel.ts';
    const chat = new ChatPanel(document.getElementById('messages'));
    chat.setGalaxyServerUrl('https://usegalaxy.org');
    chat.addUserMessage('Show me the Galaxy notebook and analysis outputs.');
    chat.startAssistantMessage();
    chat.appendDelta('The notebook is ready: [Analysis notebook](https://usegalaxy.org/published/page?id=0123456789abcdef).\\n\\nDataset ID: \\u0060fedcba98765432100123456789abcdef\\u0060\\n\\nHistory ID: 0123456789abcdeffedcba9876543210');
    chat.finishAssistantMessage();
    new ArtifactPanel().setNotebookMarkdown(${JSON.stringify(notebook)});
    </script></body></html>`;
  const server = await createServer({
    root,
    cacheDir,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "galaxy-links-fixture",
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== "/__links_fixture") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(fixture);
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1420, height: 720 });
    await page.goto(`http://127.0.0.1:${address.port}/__links_fixture`);
    await expect(page.locator("#notebook-view a")).toHaveCount(4);
    await expect(page.locator("#messages a")).toHaveCount(3);
    const history = page.locator('#notebook-view a[title="Open Galaxy history"]');
    await expect(history).toHaveAttribute(
      "href",
      "https://usegalaxy.org/histories/view?id=0123456789abcdeffedcba9876543210",
    );
    // Intercept the destination so this checks navigation without accessing the user's data.
    await context.route("https://usegalaxy.org/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "Galaxy destination fixture" }),
    );
    const popupPromise = page.waitForEvent("popup");
    await history.click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toBe(
      "https://usegalaxy.org/histories/view?id=0123456789abcdeffedcba9876543210",
    );
    expect(page.url()).toContain("/__links_fixture");
    await popup.close();
    expect(errors).toEqual([]);
    await page.waitForTimeout(300); // Let the real message fade-in animation finish.
    await page.screenshot({ path: test.info().outputPath("galaxy-links.png"), fullPage: true });
  } finally {
    await server.close();
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});
