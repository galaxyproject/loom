import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startGalaxyCredentialBroker } from "../extensions/loom/galaxy-credential-broker";

function read(socket: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect(socket);
    let data = "";
    client.on("error", reject);
    client.on("connect", () => client.write(token + "\n"));
    client.on("data", (chunk) => (data += chunk));
    client.on("end", () => resolve(data));
  });
}
describe("Galaxy credential capabilities", () => {
  it("releases only the selected profile's credential and rejects unknown capabilities", async () => {
    const broker = startGalaxyCredentialBroker([
      {
        id: "us",
        name: "us",
        url: "https://us.example",
        apiKey: "private-us",
        mcpServer: "galaxy",
      },
      {
        id: "eu",
        name: "eu",
        url: "https://eu.example",
        apiKey: "private-eu",
        mcpServer: "galaxy_eu",
      },
    ]);
    try {
      const [us, eu, invalid] = await Promise.all([
        read(broker.socket, broker.tokens.us),
        read(broker.socket, broker.tokens.eu),
        read(broker.socket, "not-a-capability"),
      ]);
      expect(JSON.parse(us)).toEqual({ url: "https://us.example", apiKey: "private-us" });
      expect(JSON.parse(eu)).toEqual({ url: "https://eu.example", apiKey: "private-eu" });
      expect(invalid).toBe("");
      if (process.platform !== "win32")
        expect(fs.statSync(path.dirname(broker.socket)).mode & 0o777).toBe(0o700);
    } finally {
      broker.close();
      broker.close();
    }
  });
});

it("reads encrypted-profile keys from the inherited pipe without a plaintext key in config or env", async () => {
  const { spawn } = await import("node:child_process");
  const os = await import("node:os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "loom-key-pipe-"));
  fs.mkdirSync(path.join(home, ".loom"));
  fs.writeFileSync(
    path.join(home, ".loom", "config.json"),
    JSON.stringify({
      galaxy: {
        active: "us",
        profiles: {
          us: { url: "https://us.example", apiKeyEncrypted: "unusable-without-shell" },
          eu: { url: "https://eu.example", apiKeyEncrypted: "unusable-without-shell" },
        },
      },
    }),
  );
  try {
    const { pathToFileURL } = await import("node:url");
    const script = `import {listGalaxyConnections} from ${JSON.stringify(pathToFileURL(path.resolve("extensions/loom/galaxy-connections.ts")).href)};console.log(JSON.stringify(listGalaxyConnections().map(c=>({name:c.name,keyCorrect:c.apiKey==='pipe-'+c.name+'-key'}))));`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LOOM_GALAXY_KEYS_FD: "3" },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    (child.stdio[3] as import("node:stream").Writable).end(
      JSON.stringify({ us: "pipe-us-key", eu: "pipe-eu-key" }),
    );
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      { name: "us", keyCorrect: true },
      { name: "eu", keyCorrect: true },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 10000);

it("redacts MCP credential capabilities from tool output", async () => {
  const { collectSecretValues, redactSecrets } =
    await import("../extensions/loom/secret-redaction");
  const capability = "b".repeat(64);
  const secrets = collectSecretValues({} as never, { ORBIT_GALAXY_MCP_abcdef_TOKEN: capability });
  expect(redactSecrets(`capability=${capability}`, secrets)).toBe("capability=[redacted]");
});
