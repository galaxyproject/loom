import { describe, expect, it } from "vitest";
import { PromptQueue, queuedPreview } from "../app/src/renderer/prompt-queue.js";

describe("PromptQueue", () => {
  it("queues and flushes messages FIFO", () => {
    const queue = new PromptQueue();

    queue.enqueue("first");
    queue.enqueue("second");
    queue.enqueue("third");

    expect(queue.items).toEqual(["first", "second", "third"]);
    expect(queue.flushNext()).toBe("first");
    expect(queue.flushNext()).toBe("second");
    expect(queue.items).toEqual(["third"]);
  });

  it("removes one queued message without disturbing the rest", () => {
    const queue = new PromptQueue();

    queue.enqueue("first");
    queue.enqueue("second");
    queue.enqueue("third");
    queue.remove(1);
    queue.remove(99);

    expect(queue.items).toEqual(["first", "third"]);
  });

  it("clears all queued messages for abort/error cleanup", () => {
    const queue = new PromptQueue();

    queue.enqueue("first");
    queue.enqueue("second");
    queue.enqueue("third");
    queue.clear();

    expect(queue.items).toEqual([]);
    expect(queue.collapsed).toBe(false);
    expect(queue.flushNext()).toBeUndefined();
  });

  it("auto-collapses only while the queue has more than two messages", () => {
    const queue = new PromptQueue();

    queue.enqueue("first");
    queue.enqueue("second");
    expect(queue.collapsed).toBe(false);

    queue.enqueue("third");
    expect(queue.collapsed).toBe(true);

    queue.flushNext();
    expect(queue.collapsed).toBe(false);
  });

  it("normalizes and truncates queue previews", () => {
    const longText = `  ${"word ".repeat(30)}  `;

    expect(queuedPreview(" first\n\nsecond\tthird ")).toBe("first second third");
    expect(queuedPreview(longText)).toHaveLength(80);
    expect(queuedPreview(longText)).toMatch(/\u2026$/);
  });
});
