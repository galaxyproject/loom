import { describe, it, expect, vi } from "vitest";
import { PendingPrompts } from "./pending-prompts.js";

function prompt(id: string) {
  return { type: "prompt", message: "hi", id };
}

function promptResponse(id: string, rest: Record<string, unknown>) {
  return { type: "response", command: "prompt", id, ...rest };
}

describe("PendingPrompts", () => {
  it("rejects with pi's reason when preflight refuses the prompt", () => {
    const prompts = new PendingPrompts();
    const settle = vi.fn();
    const id = prompts.track(settle);
    prompts.sent(prompt(id), "brain");

    prompts.observe(
      promptResponse(id, { success: false, error: 'No API key found for "fakeprov".' }),
    );

    expect(settle).toHaveBeenCalledExactlyOnceWith('No API key found for "fakeprov".');
  });

  it("still rejects a refusal that carries no reason", () => {
    const prompts = new PendingPrompts();
    const settle = vi.fn();
    const id = prompts.track(settle);

    prompts.observe(promptResponse(id, { success: false }));

    expect(settle).toHaveBeenCalledExactlyOnceWith("The agent rejected the prompt");
  });

  it.each(["queued", "handled", "started"])("resolves a %s prompt", (disposition) => {
    const prompts = new PendingPrompts();
    const settle = vi.fn();
    const id = prompts.track(settle);

    prompts.observe(promptResponse(id, { success: true, data: { disposition } }));

    expect(settle).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("settles each prompt once, and only from its own response", () => {
    const prompts = new PendingPrompts();
    const first = vi.fn();
    const second = vi.fn();
    const firstId = prompts.track(first);
    const secondId = prompts.track(second);
    expect(firstId).not.toBe(secondId);

    prompts.observe(promptResponse(secondId, { success: false, error: "nope" }));
    prompts.observe(promptResponse(secondId, { success: true }));
    // A response to some other command with the same id is not this prompt's answer.
    prompts.observe({ type: "response", command: "get_state", id: firstId, success: true });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith("nope");
  });

  it("ignores responses for ids it never issued", () => {
    const prompts = new PendingPrompts();
    const settle = vi.fn();
    prompts.track(settle);

    prompts.observe(promptResponse("web_3", { success: false, error: "x" }));
    prompts.observe({ type: "response", command: "prompt", success: false, error: "no id" });

    expect(settle).not.toHaveBeenCalled();
  });

  it("fails a prompt there was no brain to write to", () => {
    const prompts = new PendingPrompts();
    const settle = vi.fn();
    const id = prompts.track(settle);

    prompts.unsent({ type: "prompt", message: "hi" }, "ignored");
    prompts.unsent(prompt(id), "Agent is not running");

    expect(settle).toHaveBeenCalledExactlyOnceWith("Agent is not running");
  });

  it("abandons only the prompts written to the brain that went away", () => {
    const prompts = new PendingPrompts();
    const oldBrain = {};
    const newBrain = {};
    const onOld = vi.fn();
    const onNew = vi.fn();
    const held = vi.fn();
    prompts.sent(prompt(prompts.track(onOld)), oldBrain);
    prompts.sent(prompt(prompts.track(onNew)), newBrain);
    // Held during a drain: not yet written anywhere, so no exit can fail it.
    const heldId = prompts.track(held);

    expect(prompts.abandon(oldBrain)).toBe(1);

    // Quietly: a stop is not a failure (#564); the "stopped" status resets the UI.
    expect(onOld).toHaveBeenCalledExactlyOnceWith(null);
    expect(onNew).not.toHaveBeenCalled();
    expect(held).not.toHaveBeenCalled();

    prompts.sent(prompt(heldId), newBrain);
    expect(prompts.abandon(newBrain)).toBe(2);
    expect(onNew).toHaveBeenCalledExactlyOnceWith(null);
    expect(held).toHaveBeenCalledExactlyOnceWith(null);
  });

  // Other channels forward an id the browser picked; one that happens to match
  // a prompt's must not fail it or move it to another brain.
  it("leaves a prompt alone when a non-prompt message carries its id", () => {
    const prompts = new PendingPrompts();
    const brain = {};
    const settle = vi.fn();
    const id = prompts.track(settle);
    prompts.sent(prompt(id), brain);

    const forged = { type: "extension_ui_response", id, value: "x" };
    prompts.unsent(forged, "Agent is not running");
    prompts.sent(forged, {});
    expect(settle).not.toHaveBeenCalled();

    prompts.abandon(brain);
    expect(settle).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("drops a disconnected client's prompts without answering them", () => {
    const prompts = new PendingPrompts();
    const brain = {};
    const gone = vi.fn();
    const stays = vi.fn();
    const goneId = prompts.track(gone, "socket-a");
    const staysId = prompts.track(stays, "socket-b");
    prompts.sent(prompt(goneId), brain);
    prompts.sent(prompt(staysId), brain);

    prompts.forget("socket-a");
    prompts.observe(promptResponse(goneId, { success: false, error: "late" }));
    expect(gone).not.toHaveBeenCalled();
    // Nothing left to settle for the dropped one when its brain goes away.
    expect(prompts.abandon(brain)).toBe(1);
    expect(stays).toHaveBeenCalledExactlyOnceWith(null);
  });
});
