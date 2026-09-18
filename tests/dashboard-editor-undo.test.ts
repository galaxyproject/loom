import { describe, expect, it } from "vitest";
import { DEFAULT_UNDO_DEPTH, UndoStack } from "../app/src/renderer/dashboard/editor/undo-stack.js";

describe("UndoStack", () => {
  it("returns the most recent entry first", () => {
    const stack = new UndoStack<string>();
    stack.push("removed a panel", "one");
    stack.push("removed another", "two");
    expect(stack.size).toBe(2);
    expect(stack.pop()).toEqual({ label: "removed another", state: "two", source: "editor" });
    expect(stack.pop()).toEqual({ label: "removed a panel", state: "one", source: "editor" });
    expect(stack.pop()).toBeNull();
  });

  it("peeks without consuming, which is what labels the Undo control", () => {
    const stack = new UndoStack<string>();
    expect(stack.peek()).toBeNull();
    expect(stack.canUndo).toBe(false);
    stack.push("removed a panel", "one");
    expect(stack.peek()?.label).toBe("removed a panel");
    expect(stack.size).toBe(1);
    expect(stack.canUndo).toBe(true);
  });

  it("drops the oldest entry past its capacity", () => {
    const stack = new UndoStack<number>(3);
    for (let i = 1; i <= 5; i++) stack.push(`change ${i}`, i);
    expect(stack.size).toBe(3);
    expect([stack.pop()?.state, stack.pop()?.state, stack.pop()?.state]).toEqual([5, 4, 3]);
  });

  it("records who made the change, so an agent's can be surfaced differently", () => {
    const stack = new UndoStack<string>();
    stack.push("the dashboard changed", "x", "external");
    expect(stack.peek()?.source).toBe("external");
  });

  it("keeps at least one slot however it is configured", () => {
    for (const bad of [0, -5, Number.NaN]) {
      const stack = new UndoStack<number>(bad);
      stack.push("a", 1);
      stack.push("b", 2);
      expect(stack.size).toBe(1);
      expect(stack.pop()?.state).toBe(2);
    }
  });

  it("clears", () => {
    const stack = new UndoStack<number>();
    stack.push("a", 1);
    stack.clear();
    expect(stack.canUndo).toBe(false);
    expect(stack.pop()).toBeNull();
  });

  it("defaults to a depth worth having", () => {
    const stack = new UndoStack<number>();
    for (let i = 0; i < DEFAULT_UNDO_DEPTH + 5; i++) stack.push(`c${i}`, i);
    expect(stack.size).toBe(DEFAULT_UNDO_DEPTH);
  });
});
