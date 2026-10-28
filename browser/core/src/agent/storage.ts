import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import {
  SqliteStorage,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import { DEFAULT_BRAND } from "./brand";

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type OoDatabase = InstanceType<Sqlite3["oo1"]["DB"]>;
type OoStatement = ReturnType<OoDatabase["prepare"]>;

let module: Promise<Sqlite3> | undefined;
const sqlite3 = () => (module ??= sqlite3InitModule());

/**
 * pi-durable's `SqliteDatabase` over SQLite's WebAssembly build: one operation at a time, in call
 * order, and a transaction's handle stops working once its callback settles.
 */
export class WasmSqliteDatabase implements SqliteDatabase {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly statements = new Map<string, OoStatement>();
  private readonly direct: SqliteExecutor;

  constructor(private readonly database: OoDatabase) {
    this.direct = this.executor((operation) => this.inOrder(operation));
  }

  exec(sql: string): Promise<void> {
    return this.direct.exec(sql);
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.direct.run(sql, ...params);
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.direct.get<T>(sql, ...params);
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.direct.all<T>(sql, ...params);
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.inOrder(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      let active = true;
      const handle = this.executor(async (operation) => {
        if (!active) throw new Error("SQLite transaction handle is no longer active");
        return operation();
      });
      try {
        const result = await callback(handle);
        active = false;
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        active = false;
        try {
          this.database.exec("ROLLBACK");
        } catch (rollback) {
          throw new AggregateError(
            [error, rollback],
            "SQLite transaction failed and rollback failed",
          );
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.inOrder(() => {
      for (const prepared of this.statements.values()) prepared.finalize();
      this.statements.clear();
      this.database.close();
    });
  }

  private inOrder<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  /** SQL through `guard`, on statements prepared once per SQL text. */
  private executor(guard: <T>(operation: () => T) => Promise<T>): SqliteExecutor {
    const step = (sql: string, params: SqliteValue[]) => {
      let prepared = this.statements.get(sql);
      if (!prepared) {
        prepared = this.database.prepare(sql);
        this.statements.set(sql, prepared);
      }
      prepared.reset(true);
      if (params.length) prepared.bind(params as never);
      return prepared;
    };
    return {
      exec: (sql) => guard(() => void this.database.exec(sql)),
      run: (sql, ...params) =>
        guard(() => {
          const prepared = step(sql, params);
          prepared.step();
          prepared.reset(true);
        }),
      get: <T extends object>(sql: string, ...params: SqliteValue[]) =>
        guard(() => {
          const prepared = step(sql, params);
          const row = prepared.step() ? (prepared.get({}) as T) : undefined;
          prepared.reset(true);
          return row;
        }),
      all: <T extends object>(sql: string, ...params: SqliteValue[]) =>
        guard(() => {
          const prepared = step(sql, params);
          const rows: T[] = [];
          while (prepared.step()) rows.push(prepared.get({}) as T);
          prepared.reset(true);
          return rows;
        }),
    };
  }
}

/**
 * Durable storage in the origin private file system, in a dedicated worker. `brand` names the
 * file pool, one per brand, so two flavors on one origin never share files.
 */
async function opfsStorage(name: string, brand: string): Promise<Storage> {
  const s = await sqlite3();
  // Its types omit the option that lets a failed install be tried again.
  const options = {
    directory: `/${brand}`,
    name: `${brand}-opfs`,
    forceReinitIfPreviouslyFailed: true,
  };
  const pool = await s.installOpfsSAHPoolVfs(options);
  await pool.reserveMinimumCapacity(pool.getFileCount() + 2);
  const database = new WasmSqliteDatabase(new pool.OpfsSAHPoolDb(`/${name}.sqlite3`));
  await database.exec("PRAGMA journal_mode = TRUNCATE");
  return SqliteStorage.open(database);
}

export interface OpenedStorage {
  storage: Storage;
  /** Why the browser keeps no files, when it keeps none: the session then ends with the page. */
  unkept?: string;
}

/** The storage of `name` in `pool`: OPFS where the browser has it, memory otherwise. */
export async function openStorage(name: string, pool = DEFAULT_BRAND.id): Promise<OpenedStorage> {
  // A tab that just handed the storage over may still be letting go of its files.
  let failure: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return { storage: await opfsStorage(name, pool) };
    } catch (error) {
      failure = error;
      if ((error as Error)?.name !== "NoModificationAllowedError") break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  console.warn(`[${pool}] files are not kept:`, failure);
  const { name: kind, message } = (failure ?? {}) as Partial<Error>;
  return {
    storage: new MemoryStorage(),
    unkept:
      kind === "SecurityError"
        ? 'the browser refuses this site storage, as Firefox does in private windows and with "Never remember history"'
        : [kind, message].filter(Boolean).join(": ") || String(failure),
  };
}

/**
 * Hold `name` for this tab: OPFS lets one tab open a storage at a time. Resolves once held;
 * `waiting` runs first when another tab holds it, `lost` once another tab takes it over.
 * `steal` takes it from the tab that holds it.
 */
export function holdStorage(
  name: string,
  options: { steal?: boolean; waiting?: () => void; lost?: () => void } = {},
): Promise<void> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) return Promise.resolve();
  const key = name;
  return new Promise((held) => {
    const keep = () => {
      held();
      return new Promise<never>(() => {});
    };
    const hold = (steal: boolean) =>
      void locks.request(key, { steal }, keep).catch(() => options.lost?.());
    if (options.steal) {
      hold(true);
      return;
    }
    void locks
      .request(key, { ifAvailable: true }, (lock) => {
        if (lock) return keep();
        options.waiting?.();
        hold(false);
        return undefined;
      })
      .catch(() => options.lost?.());
  });
}
