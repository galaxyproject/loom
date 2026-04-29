/**
 * ShellPanel — small auto-scrolling activity log at the bottom of the chat pane.
 *
 * Shows a stream of agent events: tool calls, tool results, status updates,
 * truncated stdout from run_command. Useful for "what is the agent doing right
 * now?" debugging during long-running steps.
 */

export type ShellLineType =
  | "tool-start"
  | "tool-end"
  | "tool-error"
  | "status"
  | "info"
  | "stdout";

export class ShellPanel {
  private body: HTMLElement;
  private scrollLocked = true;

  constructor(body: HTMLElement) {
    this.body = body;
    this.body.addEventListener("scroll", () => {
      const { scrollTop, scrollHeight, clientHeight } = this.body;
      this.scrollLocked = scrollHeight - scrollTop - clientHeight < 30;
    });
  }

  /** Append a line. Automatically scrolls to bottom if user hasn't scrolled up. */
  append(text: string, type: ShellLineType = "info"): void {
    const el = document.createElement("div");
    el.className = `shell-line shell-${type}`;
    el.textContent = text;
    this.body.appendChild(el);

    // Cap at 500 lines so memory doesn't balloon during long runs
    while (this.body.childElementCount > 500) {
      this.body.removeChild(this.body.firstChild!);
    }

    if (this.scrollLocked) {
      requestAnimationFrame(() => {
        this.body.scrollTop = this.body.scrollHeight;
      });
    }
  }

  clear(): void {
    this.body.innerHTML = "";
  }

  /** Last N lines of the shell stream as plain text — used by the issue reporter. */
  tail(n: number): string {
    const lines: string[] = [];
    const children = this.body.children;
    const start = Math.max(0, children.length - n);
    for (let i = start; i < children.length; i++) {
      lines.push(children[i].textContent ?? "");
    }
    return lines.join("\n");
  }
}
