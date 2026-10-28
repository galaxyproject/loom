#!/usr/bin/env node
// Only this trusted launcher sees its one-use credential capability. The MCP
// server receives its own Galaxy key, never other profiles' credentials.
import net from "node:net";
import { spawn } from "node:child_process";
import { readEnv } from "../shared/orbit-env.js";
const socket = readEnv("GALAXY_MCP_SOCKET");
const token = readEnv("GALAXY_MCP_TOKEN");
const spec = process.argv[2];
if (!socket || !token || !/^galaxy-mcp(?:[>=<~!0-9.,]*)$/.test(spec || "")) process.exit(1);
const credentials = await new Promise((resolve, reject) => {
  const client = net.connect(socket);
  let data = "";
  client.setTimeout(10_000, () => client.destroy(new Error("Galaxy credential port timed out.")));
  client.on("connect", () => client.write(token + "\n"));
  client.on("error", reject);
  client.on("data", (bytes) => {
    data += bytes.toString("utf8");
    if (data.length > 65_536) client.destroy(new Error("Invalid credential envelope."));
  });
  client.on("end", () => {
    try {
      resolve(JSON.parse(data));
    } catch {
      reject(new Error("Invalid credential envelope."));
    }
  });
});
const env = { ...process.env };
for (const key of Object.keys(env))
  if (key.startsWith("LOOM_GALAXY_") || key.startsWith("ORBIT_GALAXY_")) delete env[key];
env.GALAXY_URL = credentials.url;
env.GALAXY_API_KEY = credentials.apiKey;
const child = spawn("uvx", [spec], { stdio: "inherit", env, windowsHide: true });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(1));
child.on("exit", (code) => process.exit(code ?? 1));
