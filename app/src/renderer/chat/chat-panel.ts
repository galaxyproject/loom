import { marked } from "marked";
import {
  TEAM_DISPATCH_KIND,
  type TeamDispatchDetails,
} from "../../../../shared/team-dispatch-contract.js";

export class ChatPanel {
  private container: HTMLElement;
  private currentMessage: HTMLElement | null = null;
  private currentText = "";
  private toolCards = new Map<string, HTMLElement>();
  private scrollLocked = true;
  private thinkingEl: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    this.container.addEventListener("scroll", () => {
      const { scrollTop, scrollHeight, clientHeight } = this.container;
      this.scrollLocked = scrollHeight - scrollTop - clientHeight < 40;
    });
  }

  addUserMessage(text: string): void {
    const el = document.createElement("div");
    el.className = "message user";
    el.textContent = text;
    this.container.appendChild(el);
    this.scrollToBottom();
  }

  /** Wipe all chat messages and reset internal state. */
  clear(): void {
    this.container.innerHTML = "";
    this.currentMessage = null;
    this.currentText = "";
    this.toolCards.clear();
    this.thinkingEl = null;
  }

  showThinking(): void {
    this.hideThinking();
    const el = document.createElement("div");
    el.className = "message assistant thinking-indicator";
    el.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span> thinking';
    this.thinkingEl = el;
    this.container.appendChild(el);
    this.scrollToBottom();
  }

  hideThinking(): void {
    if (this.thinkingEl) {
      this.thinkingEl.remove();
      this.thinkingEl = null;
    }
  }

  hasActiveMessage(): boolean {
    return this.currentMessage !== null;
  }

  hasContent(): boolean {
    return this.container.children.length > 0;
  }

  startAssistantMessage(): void {
    this.currentText = "";
    const el = document.createElement("div");
    el.className = "message assistant";
    el.innerHTML = '<span class="cursor-blink"></span>';
    this.container.appendChild(el);
    this.currentMessage = el;
    this.scrollToBottom();
  }

  appendDelta(delta: string): void {
    if (!this.currentMessage) return;
    this.currentText += delta;
    this.renderCurrentMessage();
    this.scrollToBottom();
  }

  finishAssistantMessage(): void {
    if (this.currentMessage) {
      this.renderCurrentMessage();
    }
    // Clean up any stray cursors across the whole container
    this.container.querySelectorAll(".cursor-blink").forEach(c => c.remove());
    this.currentMessage = null;
    this.currentText = "";
  }

  addToolCard(id: string, name: string): void {
    const card = document.createElement("div");
    card.className = "tool-card";
    card.innerHTML = `
      <div class="tool-card-header">
        <span class="tool-status running"></span>
        <span>${escapeHtml(name)}</span>
      </div>
      <div class="tool-card-body"></div>
    `;

    card.querySelector(".tool-card-header")!.addEventListener("click", () => {
      card.classList.toggle("expanded");
    });

    this.toolCards.set(id, card);

    // Insert into current assistant message or append to container
    if (this.currentMessage) {
      // Insert before the cursor
      const cursor = this.currentMessage.querySelector(".cursor-blink");
      if (cursor) {
        this.currentMessage.insertBefore(card, cursor);
      } else {
        this.currentMessage.appendChild(card);
      }
    } else {
      this.container.appendChild(card);
    }

    this.scrollToBottom();
  }

  updateToolCard(
    id: string,
    status: "running" | "done" | "error",
    result?: string,
    details?: TeamDispatchDetails | { kind?: string; [k: string]: unknown },
  ): void {
    const card = this.toolCards.get(id);
    if (!card) return;

    const dot = card.querySelector(".tool-status")!;
    dot.className = `tool-status ${status}`;

    // Specialized branch: team_dispatch details render as a collapsible card.
    if (details && (details as { kind?: string }).kind === TEAM_DISPATCH_KIND) {
      const body = card.querySelector(".tool-card-body")!;
      body.textContent = "";
      body.appendChild(renderTeamDispatchCard(details as TeamDispatchDetails));
      return;
    }

    if (result) {
      const body = card.querySelector(".tool-card-body")!;
      body.textContent = result.slice(0, 2000);
    }
  }

  addErrorMessage(text: string): void {
    const el = document.createElement("div");
    el.className = "message assistant";
    el.style.color = "var(--error)";
    el.textContent = text;
    this.container.appendChild(el);
    this.scrollToBottom();
  }

  /** Add a system/info message with neutral styling and HTML support. */
  addInfoMessage(html: string): void {
    const el = document.createElement("div");
    el.className = "message assistant system-info";
    el.innerHTML = html;
    this.container.appendChild(el);
    this.scrollToBottom();
  }

  private renderCurrentMessage(): void {
    if (!this.currentMessage) return;

    // Preserve tool cards
    const cards = Array.from(this.currentMessage.querySelectorAll(".tool-card"));

    const html = marked.parse(this.currentText, { async: false }) as string;
    this.currentMessage.innerHTML = html + '<span class="cursor-blink"></span>';

    // Re-insert tool cards before the cursor
    const cursor = this.currentMessage.querySelector(".cursor-blink");
    for (const card of cards) {
      if (cursor) {
        this.currentMessage.insertBefore(card, cursor);
      } else {
        this.currentMessage.appendChild(card);
      }
    }
  }

  private scrollToBottom(): void {
    if (this.scrollLocked) {
      requestAnimationFrame(() => {
        this.container.scrollTop = this.container.scrollHeight;
      });
    }
  }
}

function escapeHtml(text: string): string {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
}

function renderTeamDispatchCard(details: TeamDispatchDetails): HTMLElement {
  const { spec, turns = [], summary } = details;
  const wrapper = document.createElement("div");
  wrapper.className = "team-dispatch-card";

  const header = document.createElement("button");
  header.className = "team-dispatch-header";
  header.type = "button";
  const roleLabels = (spec?.roles ?? []).map((r) => r.name).join(" × ");
  header.textContent = `${roleLabels || "Team"} — ${summary ?? `${turns.length} turn(s)`}`;

  const body = document.createElement("div");
  body.className = "team-dispatch-body hidden";

  for (const t of turns) {
    const row = document.createElement("div");
    row.className = "team-turn";
    const meta = document.createElement("div");
    meta.className = "team-turn-meta";
    const approvedMark = t.approved === true ? " ✓" : t.approved === false ? " ✗" : "";
    meta.textContent = `Round ${t.round} — ${t.role}${approvedMark}`;
    const content = document.createElement("pre");
    content.className = "team-turn-content";
    content.textContent = t.content ?? "";
    row.appendChild(meta);
    row.appendChild(content);
    body.appendChild(row);
  }

  header.addEventListener("click", () => body.classList.toggle("hidden"));
  wrapper.appendChild(header);
  wrapper.appendChild(body);
  return wrapper;
}
