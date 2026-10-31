// Orbit's brain in a real browser worker, both tiers: the preflight page built through the
// production config (served as files, as Galaxy would) and served by the dev server. Build stubs
// are empty objects and dev stubs are real modules, so a module-scope failure can show in one
// tier and not the other; either way the page would only say "worker failed to start".
//
//   node e2e/orbit-preflight-drive.cjs            both tiers
//   TIERS=built node e2e/orbit-preflight-drive.cjs
//
// Not in run-all.sh yet; the CI matrix leg wires it (slice 3, commit 20).
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const BROWSER = path.resolve(__dirname, "..");
const CONFIG = "core/src/agent/orbit/preflight.vite.ts";
const DEV_PORT = 5175;
const TIERS = (process.env.TIERS || "built,dev").split(",");

let failed = 0;
const check = (name, ok, detail) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };

function serveFiles(root) {
    const server = http.createServer((req, res) => {
        const file = path.join(root, decodeURIComponent(req.url.split("?")[0]));
        if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function waitFor(url, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try {
            if ((await fetch(url)).ok) return true;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

async function preflight(browser, tier, url) {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const handle = await page
        .waitForFunction(() => globalThis.preflight, null, { timeout: 120000 })
        .catch(() => null);
    const result = handle ? await handle.jsonValue() : { ok: false, error: "no answer within 120 s" };
    check(`${tier}: Orbit booted in the worker`, result.ok, result.ok ? `${result.tools} tools` : result.error);
    check(`${tier}: registry opened as writer`, result.mode === "writer", `mode ${result.mode}`);
    if (!result.ok) console.log(logs.slice(-15).join("\n"));
    await page.close();
}

(async () => {
    const browser = await chromium.launch();
    const cleanup = [];
    try {
        if (TIERS.includes("built")) {
            const out = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-preflight-"));
            const build = spawnSync(
                "npx",
                ["vite", "build", "--config", CONFIG, "--configLoader", "runner", "--logLevel", "warn"],
                { cwd: BROWSER, env: { ...process.env, PREFLIGHT_OUT: out }, stdio: "inherit" },
            );
            check("built: the preflight builds", build.status === 0);
            if (build.status === 0) {
                const server = await serveFiles(out);
                cleanup.push(() => server.close());
                await preflight(browser, "built", `http://127.0.0.1:${server.address().port}/preflight.html`);
            }
        }
        if (TIERS.includes("dev")) {
            const dev = spawn(
                "npx",
                ["vite", "--config", CONFIG, "--configLoader", "runner", "--port", String(DEV_PORT), "--strictPort"],
                { cwd: BROWSER, env: process.env, stdio: "ignore", detached: true },
            );
            cleanup.push(() => process.kill(-dev.pid));
            const url = `http://localhost:${DEV_PORT}/preflight.html`;
            const up = await waitFor(url, 60000);
            check("dev: the dev server answers", up);
            if (up) await preflight(browser, "dev", url);
        }
    } finally {
        await browser.close();
        for (const stop of cleanup) {
            try {
                stop();
            } catch {}
        }
    }
    process.exit(failed ? 1 : 0);
})();
