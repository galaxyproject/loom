import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { WasmSqliteDatabase } from "./storage";

const sqlite3 = await sqlite3InitModule();
const memory = () => new WasmSqliteDatabase(new sqlite3.oo1.DB(":memory:"));

registerStorageConformance(
  { describe, expect, it },
  "SqliteStorage over WasmSqliteDatabase",
  async (use) => {
    const storage = await SqliteStorage.open(memory());
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  },
);

describe("WasmSqliteDatabase transactions", () => {
  const table = async () => {
    const database = memory();
    await database.exec("CREATE TABLE t (v INTEGER)");
    return database;
  };

  it("rolls back and rethrows when the callback throws", async () => {
    const database = await table();
    const failure = new Error("no");
    await expect(
      database.transaction(async (tx) => {
        await tx.run("INSERT INTO t VALUES (?)", 1);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await database.all("SELECT v FROM t")).toEqual([]);
  });

  it("refuses a handle used after its callback settled", async () => {
    const database = await table();
    let kept: Parameters<Parameters<typeof database.transaction>[0]>[0] | undefined;
    await database.transaction(async (tx) => {
      kept = tx;
    });
    await expect(kept!.run("INSERT INTO t VALUES (1)")).rejects.toThrow(/no longer active/);
  });

  it("runs calls made during a transaction after it, in call order", async () => {
    const database = await table();
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const transaction = database.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES (1)");
      await open;
      await tx.run("INSERT INTO t VALUES (2)");
    });
    const after = database.run("INSERT INTO t VALUES (3)");
    const seen = database.all<{ v: number }>("SELECT v FROM t");
    release();
    await Promise.all([transaction, after]);
    expect((await seen).map((row) => row.v)).toEqual([1, 2, 3]);
  });

  it("returns undefined for no row", async () => {
    const database = await table();
    expect(await database.get("SELECT v FROM t WHERE v = ?", 9)).toBeUndefined();
  });
});
