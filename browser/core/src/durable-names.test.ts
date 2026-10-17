/**
 * Names already written into users' browser databases and saved documents. They predate the
 * split and say olit on purpose (LAYOUT.md): renaming one orphans everything kept under it, so a
 * rename has to come with a migration, never as part of a cleanup.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Binding, FollowUps, Sessions } from "./agent/documents";
import { isSessionDocument, SCHEMA } from "./agent/saved";
import { WATCH_TASK } from "./agent/watch";

describe("durable names", () => {
  it("keeps the document kinds", () => {
    expect(Binding.definition.kind).toBe("olit.binding");
    expect(FollowUps.definition.kind).toBe("olit.follow-ups");
    expect(Sessions.definition.kind).toBe("olit.sessions");
  });

  it("keeps the watch task", () => {
    expect(WATCH_TASK).toBe("olit.galaxy-watch");
  });

  it("keeps the saved session's marker key, on read and on write", () => {
    const session = { id: "s1", title: "t", createdAt: "x", updatedAt: "x", turn: 0 };
    expect(isSessionDocument({ olit_session: SCHEMA, session, entries: [] })).toBe(true);
    expect(isSessionDocument({ orbit_session: SCHEMA, session, entries: [] })).toBe(false);
    const runtime = readFileSync(join(__dirname, "agent", "runtime.ts"), "utf8");
    expect(runtime).toContain("olit_session: SCHEMA,");
  });
});
