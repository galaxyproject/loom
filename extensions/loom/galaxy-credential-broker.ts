/** A process-local credential port for isolated MCP children. No credentials on disk. */
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type { GalaxyConnection } from "./galaxy-connections.js";

export function startGalaxyCredentialBroker(connections: GalaxyConnection[]): {
  socket: string;
  tokens: Record<string, string>;
  close(): void;
} {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "loom-galaxy-"));
  fs.chmodSync(folder, 0o700);
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\loom-galaxy-${randomBytes(16).toString("hex")}`
      : path.join(folder, "credentials.sock");
  const tokens: Record<string, string> = {};
  const permits = new Map<string, GalaxyConnection>();
  for (const c of connections) {
    tokens[c.id] = randomBytes(32).toString("hex");
    permits.set(tokens[c.id], c);
  }
  const server = net.createServer((client) => {
    client.setTimeout(5000, () => client.destroy());
    let data = "";
    client.on("error", () => {});
    client.on("data", (bytes) => {
      data += bytes.toString("utf8");
      if (data.length > 512) return client.destroy();
      if (!data.includes("\n")) return;
      const connection = permits.get(data.trim());
      if (!connection) return client.destroy();
      client.end(JSON.stringify({ url: connection.url, apiKey: connection.apiKey }) + "\n");
    });
  });
  server.on("error", () => {
    console.error("[galaxy-mcp] Credential broker could not listen.");
  });
  server.listen(socket);
  server.unref();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    process.removeListener("exit", close);
    server.close();
    fs.rmSync(folder, { recursive: true, force: true });
  };
  process.once("exit", close);
  return { socket, tokens, close };
}
