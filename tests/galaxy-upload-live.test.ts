import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import {
  tusUpload,
  buildFetchPayload,
  waitForDataset,
  type DatasetState,
} from "../extensions/loom/galaxy-upload-tus";
import { galaxyGet, galaxyPost } from "../extensions/loom/galaxy-api";

const live =
  process.env.GALAXY_URL && process.env.GALAXY_API_KEY && process.env.GALAXY_TEST_HISTORY_ID;

describe.runIf(live)("live: native upload end to end", () => {
  it("drives a small file to a terminal dataset state", async () => {
    const f = path.join(os.tmpdir(), "loom-live.txt");
    fs.writeFileSync(f, "hello loom\n");

    const { sessionId } = await tusUpload({
      baseUrl: process.env.GALAXY_URL!.replace(/\/+$/, ""),
      apiKey: process.env.GALAXY_API_KEY!,
      filePath: f,
      storagePath: path.join(os.tmpdir(), "loom-live-resume.json"),
    });

    const resp = await galaxyPost<{ outputs?: Array<{ id: string; state?: string }> }>(
      "/tools/fetch",
      buildFetchPayload({
        historyId: process.env.GALAXY_TEST_HISTORY_ID!,
        sessionId,
        fileName: "loom-live.txt",
      }),
    );

    expect(resp.outputs?.[0]?.id).toBeTruthy();

    const ds = await waitForDataset(resp.outputs![0].id, {
      get: (id) => galaxyGet<DatasetState>(`/datasets/${id}`),
    });

    expect(["ok", "error"]).toContain(ds.state);
  }, 120_000);
});
