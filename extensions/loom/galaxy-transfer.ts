/** Authenticated, bounded input transfer. Temporary bytes are private and removed. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { GalaxySite, ReroutePlan } from "./galaxy-reroute.js";
import { tusUpload, buildFetchPayload, waitForDataset } from "./galaxy-upload-tus.js";

async function contentHash(site: GalaxySite, id: string, signal?: AbortSignal): Promise<string> {
  const response = await site.response(
    `/datasets/${encodeURIComponent(id)}/display?raw=true&preview=false`,
    "GET",
    undefined,
    signal,
    3_600_000,
  );
  if (!response.body) throw new Error("Galaxy did not return dataset content.");
  const hash = createHash("sha256");
  for await (const bytes of Readable.fromWeb(response.body as never)) hash.update(bytes);
  return hash.digest("hex");
}

export async function transferGalaxyDataset(
  source: GalaxySite,
  destination: GalaxySite,
  input: ReroutePlan["inputs"][number],
  historyId: string,
  signal?: AbortSignal,
  progress?: (text: string) => void,
): Promise<{ id: string; sha256: string }> {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "loom-galaxy-transfer-"));
  await fsp.chmod(folder, 0o700);
  try {
    const space = await fsp.statfs(folder);
    if (Number(space.bavail) * Number(space.bsize) < input.bytes + 64 * 1024 * 1024)
      throw new Error("Insufficient temporary disk space for the authenticated relay.");
    const file = path.join(folder, "input");
    const response = await source.response(
      `/datasets/${encodeURIComponent(input.id)}/display?raw=true&preview=false`,
      "GET",
      undefined,
      signal,
      3_600_000,
    );
    if (!response.body) throw new Error("Source dataset content is unavailable.");
    const hash = createHash("sha256");
    let received = 0;
    const check = new Transform({
      transform(bytes, _encoding, done) {
        received += bytes.length;
        if (received > input.bytes) return done(new Error("Source content grew after preflight."));
        hash.update(bytes);
        done(null, bytes);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as never),
      check,
      fs.createWriteStream(file, { mode: 0o600 }),
      ...(signal ? [{ signal }] : []),
    );
    if (received !== input.bytes) throw new Error("Source dataset size changed during transfer.");
    const sha256 = hash.digest("hex");
    let lastProgress = 0;
    const { sessionId } = await tusUpload({
      baseUrl: destination.connection.url,
      apiKey: destination.connection.apiKey,
      filePath: file,
      storagePath: path.join(folder, "resume.json"),
      signal,
      onProgress: (sent, total) => {
        if (Date.now() - lastProgress > 10_000) {
          lastProgress = Date.now();
          progress?.(`Transferring ${input.name}: ${Math.round((sent / total) * 100)}%.`);
        }
      },
    });
    const payload = buildFetchPayload({
      historyId,
      sessionId,
      fileName: input.name,
      fileType: input.ext,
      dbkey: input.dbkey,
    });
    // The generic uploader normalizes line endings; an input copy must retain
    // the original byte stream so the checksum actually identifies the input.
    const target = (payload.targets as Array<{ elements: Array<Record<string, unknown>> }>)[0];
    target.elements[0].to_posix_lines = false;
    const result = await destination.request<{ outputs?: Array<{ id: string }> }>(
      "/tools/fetch",
      "POST",
      payload,
      signal,
    );
    const id = result.outputs?.[0]?.id;
    if (!id)
      throw new Error(
        "Upload acceptance is uncertain. Inspect the destination history before retrying the transfer.",
      );
    const dataset = await waitForDataset(id, {
      get: () =>
        destination.request(`/datasets/${encodeURIComponent(id)}`, "GET", undefined, signal),
    });
    if (!["ok", "empty"].includes(dataset.state))
      throw new Error(`Transferred input is ${dataset.state}.`);
    const metadata = await destination.request(
      `/datasets/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      signal,
    );
    if (
      String(metadata.extension ?? metadata.ext) !== input.ext ||
      String(metadata.genome_build ?? metadata.dbkey ?? "?") !== input.dbkey
    )
      throw new Error("Transferred datatype or genome metadata differs from its source.");
    if ((await contentHash(destination, id, signal)) !== sha256)
      throw new Error("Transferred input checksum differs from its source.");
    return { id, sha256 };
  } finally {
    await fsp.rm(folder, { recursive: true, force: true });
  }
}
