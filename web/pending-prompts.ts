/**
 * The browser's `agent:prompt` call, held open until the brain answers it.
 *
 * pi answers a prompt only after preflight: `{disposition}` when a turn (or a
 * command) took it, `success: false` when preflight refused it -- no model, no
 * key, compaction in progress. The desktop awaits that answer and shows a
 * refusal in the chat (#529). The web server used to answer the browser at
 * once, so a refused prompt left the user's message sitting on "thinking"
 * with nothing to say why (#563).
 *
 * Prompts carry an id of the server's own to the brain, and only a prompt
 * message can settle or re-own one: other channels forward ids the browser
 * chose, and those must not reach a prompt that may not be theirs. An entry is tied to the brain it
 * was written to, not the one running when the browser asked: a prompt held
 * while a restart drains belongs to the replacement, and the outgoing brain's
 * exit must not fail it.
 *
 * There is no time bound: pi answers "handled" only once an extension command
 * has finished, and a command can sit on a dialog for as long as the user
 * takes. The renderer never awaits the call, so a long wait blocks nothing.
 */

/** `null` when the brain took the prompt, its reason when it did not. */
export type PromptSettle = (error: string | null) => void;

interface Entry {
  settle: PromptSettle;
  client?: unknown;
  owner?: unknown;
}

export class PendingPrompts {
  private entries = new Map<string, Entry>();
  private counter = 0;

  /** Hold `client`'s prompt open; send the returned id to the brain with it. */
  track(settle: PromptSettle, client?: unknown): string {
    const id = `web_prompt_${++this.counter}`;
    this.entries.set(id, { settle, client });
    return id;
  }

  /** `message` was written to `owner`'s stdin; a prompt's fate is now that brain's. */
  sent(message: Record<string, unknown>, owner: unknown): void {
    if (message.type !== "prompt" || typeof message.id !== "string") return;
    const entry = this.entries.get(message.id);
    if (entry) entry.owner = owner;
  }

  /** Feed every line from the brain; settles the prompt a response answers. */
  observe(event: Record<string, unknown>): void {
    if (event.type !== "response" || event.command !== "prompt") return;
    if (event.success === false) {
      const error = typeof event.error === "string" && event.error ? event.error : null;
      this.finish(event.id, error ?? "The agent rejected the prompt");
    } else {
      this.finish(event.id, null);
    }
  }

  /** `message` could not be written, e.g. because there was no brain to take it. */
  unsent(message: Record<string, unknown>, error: string): void {
    if (message.type === "prompt") this.finish(message.id, error);
  }

  /**
   * `owner` is gone and will answer nothing more. Its prompts settle quietly:
   * a stop or restart is not a failure (#564), and a crash is already in the
   * chat. Returns how many settled.
   */
  abandon(owner: unknown): number {
    let settled = 0;
    for (const [id, entry] of this.entries) {
      if (entry.owner !== undefined && entry.owner === owner) {
        this.finish(id, null);
        settled++;
      }
    }
    return settled;
  }

  /** `client` went away; nobody is left to answer, so drop its prompts. */
  forget(client: unknown): void {
    for (const [id, entry] of this.entries) {
      if (entry.client === client) this.entries.delete(id);
    }
  }

  private finish(id: unknown, error: string | null): void {
    if (typeof id !== "string") return;
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.settle(error);
  }
}
