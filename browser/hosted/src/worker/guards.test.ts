import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../db/migrate";
import { LeaseFence } from "../lease/lease-fence";
import { acquireLease } from "../lease/leases";
import { bumpLeaseGen, LeaseLostError } from "../storage/postgres-storage";
import { ensureDatabase, testDatabase } from "../test-db";
import { fencedFetch } from "./fenced-fetch";
import { registerSurfaceGate, registerToolCallCap } from "./guards";

type Handler = (event: { toolName: string }) => unknown;

function events() {
  const handlers = new Map<string, Handler[]>();
  const on = (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  const fire = (event: string, payload: { toolName: string } = { toolName: "" }) =>
    (handlers.get(event) ?? []).map((h) => h(payload)).find((r) => r !== undefined);
  return { on: on as never, fire };
}

describe("the surface gate", () => {
  it("lets the surface through and blocks anything else", () => {
    const { on, fire } = events();
    registerSurfaceGate(on, new Set(["get_history_details"]));
    expect(fire("tool_call", { toolName: "get_history_details" })).toBeUndefined();
    expect(fire("tool_call", { toolName: "run_user_tool" })).toEqual({
      block: true,
      reason: "run_user_tool is not available in hosted Orbit.",
    });
  });
});

describe("the tool-call cap", () => {
  it("blocks past the cap and starts over with the user's next message, not Orbit's", () => {
    const { on, fire } = events();
    registerToolCallCap(on, 2);
    fire("input", { toolName: "", source: "rpc" } as never);
    expect(fire("tool_call")).toBeUndefined();
    expect(fire("tool_call")).toBeUndefined();
    expect(fire("tool_call")).toMatchObject({ block: true });
    fire("input", { toolName: "", source: "extension" } as never);
    expect(fire("tool_call")).toMatchObject({ block: true });
    fire("input", { toolName: "", source: "rpc" } as never);
    expect(fire("tool_call")).toBeUndefined();
  });
});

describe("the fenced global fetch", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ ...(await ensureDatabase(testDatabase("orbit_hosted_guards"))), max: 2 });
    await migrate(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("refuses a POST once the lease moved, then refuses everything", async () => {
    const storeId = `fetch-${randomUUID()}`;
    const leaseGen = (await acquireLease(pool, storeId, "worker-a", 60_000))!;
    const lost: LeaseLostError[] = [];
    const fence = new LeaseFence({ storeId, leaseGen, db: pool, onLost: (e) => lost.push(e) });
    const sent: string[] = [];
    const fetch = fencedFetch(fence, async (input, init) => {
      sent.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response("{}");
    });

    await fetch("http://llm.test/v1/chat/completions", { method: "POST" });
    await bumpLeaseGen(pool, storeId);
    await fetch("http://gtn.test/feed.json");
    await expect(fetch("http://llm.test/v1/chat/completions", { method: "POST" })).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect(lost).toHaveLength(1);
    // Tripped: even a read stays home now.
    await expect(fetch("http://gtn.test/feed.json")).rejects.toBeInstanceOf(LeaseLostError);
    expect(sent).toEqual(["POST http://llm.test/v1/chat/completions", "GET http://gtn.test/feed.json"]);
  });

  it("reads the method off a Request too", async () => {
    const storeId = `fetch-${randomUUID()}`;
    const leaseGen = (await acquireLease(pool, storeId, "worker-a", 60_000))!;
    const fence = new LeaseFence({ storeId, leaseGen, db: pool, onLost: () => {} });
    const fetch = fencedFetch(fence, async () => new Response("{}"));
    await bumpLeaseGen(pool, storeId);
    await expect(fetch(new Request("http://llm.test/v1", { method: "POST", body: "{}" }))).rejects.toBeInstanceOf(
      LeaseLostError,
    );
  });
});
