import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { WorkerMessage } from "./worker";

const received: unknown[] = [];
let load: Promise<void>;
let release: () => void;
let refuse: (err: Error) => void;

const posted: WorkerMessage[] = [];

beforeEach(() => {
  vi.resetModules();
  received.length = 0;
  posted.length = 0;
  load = new Promise<void>((resolve, reject) => {
    release = resolve;
    refuse = reject;
  });
  // Orbit's worker as the dev server loads it: some time after the page has posted "open".
  vi.doMock("./orbit/worker", async () => {
    await load;
    return {
      startOrbitWorker: () => {
        self.onmessage = ({ data }: MessageEvent) => received.push(data);
      },
    };
  });
  vi.stubEnv("orbit_brain", "orbit");
  vi.spyOn(self, "postMessage").mockImplementation(((message: WorkerMessage) => {
    posted.push(message);
  }) as typeof self.postMessage);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("./orbit/worker");
  self.onmessage = null;
});

it("keeps what the page posts before Orbit's worker has loaded, in order", async () => {
  (await import("./worker")).startAgentWorker({});
  self.onmessage!(new MessageEvent("message", { data: { type: "open" } }));
  self.onmessage!(new MessageEvent("message", { data: { type: "send", text: "hi" } }));
  expect(received).toEqual([]);
  release();
  await vi.waitFor(() =>
    expect(received).toEqual([{ type: "open" }, { type: "send", text: "hi" }]),
  );
});

it("tells the page when Orbit's worker fails to load", async () => {
  (await import("./worker")).startAgentWorker({});
  refuse(new Error("chunk missing"));
  // Only the kind: vitest rewords an error thrown from a mock's factory.
  await vi.waitFor(() =>
    expect(posted).toContainEqual({ type: "failed", message: expect.any(String) }),
  );
});
