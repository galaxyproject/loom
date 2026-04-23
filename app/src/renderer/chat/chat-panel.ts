import { marked } from "marked";
import {
  TEAM_DISPATCH_KIND,
  type TeamDispatchDetails,
} from "../../../../shared/team-dispatch-contract.js";

const PROMPT_COUNTER_STORAGE_KEY = "orbit.promptCounter";

export class ChatPanel {
  private container: HTMLElement;
  private currentMessage: HTMLElement | null = null;
  private currentText = "";
  private toolCards = new Map<string, HTMLElement>();
  private scrollLocked = true;
  private thinkingEl: HTMLElement | null = null;
  // Persist across renderer reloads (Cmd+R, HMR, crash-recovery) so prompt
  // numbering survives session interruptions. Cleared by clear().
  private promptCounter = readPersistedPromptCounter();

  constructor(container: HTMLElement) {
    this.container = container;

    this.container.addEventListener("scroll", () => {
      const { scrollTop, scrollHeight, clientHeight } = this.container;
      this.scrollLocked = scrollHeight - scrollTop - clientHeight < 40;
    });

    this.container.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const btn = target.closest<HTMLButtonElement>(
        ".plan-draft-approve,.plan-draft-edit,.plan-draft-reject",
      );
      if (!btn) return;
      const card = btn.closest<HTMLElement>(".plan-draft-card");
      const body = card?.dataset.planDraftBody ?? "";
      let action: "approve" | "edit" | "reject" = "approve";
      if (btn.classList.contains("plan-draft-edit")) action = "edit";
      else if (btn.classList.contains("plan-draft-reject")) action = "reject";
      if (action !== "edit" && card) {
        card.classList.add(action === "approve" ? "approved" : "rejected");
        card.querySelectorAll<HTMLButtonElement>(
          ".plan-draft-approve,.plan-draft-edit,.plan-draft-reject",
        ).forEach((b) => { b.disabled = true; });
      }
      this.container.dispatchEvent(
        new CustomEvent("plan-draft-action", {
          detail: { action, body },
          bubbles: true,
        }),
      );
    });
  }

  addUserMessage(text: string): void {
    const n = ++this.promptCounter;
    writePersistedPromptCounter(this.promptCounter);
    const turn = document.createElement("div");
    turn.className = "user-turn";
    turn.dataset.promptNum = String(n);

    const num = document.createElement("div");
    num.className = "prompt-num";
    num.textContent = String(n);
    num.title = `Prompt ${n}`;

    const connector = document.createElement("div");
    connector.className = "prompt-connector";

    const bubble = document.createElement("div");
    bubble.className = "message user";
    bubble.textContent = text;

    turn.appendChild(num);
    turn.appendChild(connector);
    turn.appendChild(bubble);
    this.container.appendChild(turn);
    this.scrollToBottom();
  }

  /** Wipe all chat messages and reset internal state. */
  clear(): void {
    this.container.innerHTML = "";
    this.currentMessage = null;
    this.currentText = "";
    this.toolCards.clear();
    this.thinkingEl = null;
    this.promptCounter = 0;
    writePersistedPromptCounter(0);
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

  getPromptCount(): number {
    return this.promptCounter;
  }

  /**
   * Build a plain-text transcript of turns in the inclusive prompt-number range.
   * Each turn: the user prompt text, then everything that followed until the
   * next user-turn (assistant messages, tool cards). Used by /summarize.
   */
  getTranscript(fromNum: number, toNum: number): string {
    const lo = Math.min(fromNum, toNum);
    const hi = Math.max(fromNum, toNum);
    const children = Array.from(this.container.children) as HTMLElement[];
    const parts: string[] = [];
    let activeNum: number | null = null;
    let buf: string[] = [];

    const flush = () => {
      if (activeNum !== null && activeNum >= lo && activeNum <= hi) {
        parts.push(buf.join("\n").trimEnd());
      }
      buf = [];
    };

    for (const el of children) {
      if (el.classList.contains("user-turn")) {
        flush();
        const n = Number(el.dataset.promptNum);
        activeNum = Number.isFinite(n) ? n : null;
        const userText = (el.querySelector(".message.user") as HTMLElement | null)?.textContent?.trim() ?? "";
        if (activeNum !== null) {
          buf.push(`[Prompt ${activeNum} — user]`);
          if (userText) buf.push(userText);
        }
      } else if (activeNum !== null && activeNum >= lo && activeNum <= hi) {
        const text = (el.textContent ?? "").trim();
        if (!text) continue;
        if (el.classList.contains("message") && el.classList.contains("assistant")) {
          buf.push(`[Prompt ${activeNum} — assistant]`);
          buf.push(text);
        } else {
          buf.push(text);
        }
      }
    }
    flush();
    return parts.join("\n\n---\n\n");
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

    const { text, planBlocks } = extractPlanFences(this.currentText);
    let html = marked.parse(text, { async: false }) as string;
    html = injectPlanFenceCards(html, planBlocks);
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

function readPersistedPromptCounter(): number {
  try {
    const raw = sessionStorage.getItem(PROMPT_COUNTER_STORAGE_KEY);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writePersistedPromptCounter(n: number): void {
  try {
    if (n <= 0) sessionStorage.removeItem(PROMPT_COUNTER_STORAGE_KEY);
    else sessionStorage.setItem(PROMPT_COUNTER_STORAGE_KEY, String(n));
  } catch {
    // sessionStorage may be unavailable in odd contexts — best effort only
  }
}

const PLAN_FENCE_PLACEHOLDER_PREFIX = "LOOM_PLAN_FENCE_";

/**
 * Strip ```plan ... ``` fences out of assistant markdown before marked.parse.
 * Leaves a placeholder paragraph behind so the surrounding prose keeps its
 * position; extractPlanFences + injectPlanFenceCards swap the placeholders
 * for rendered draft cards. A trailing unclosed fence is treated as still
 * in-progress and rendered as a card with whatever text has arrived so far.
 */
function extractPlanFences(src: string): { text: string; planBlocks: string[] } {
  const planBlocks: string[] = [];
  const re = /```plan\b[^\n]*\n([\s\S]*?)```/g;
  let text = src.replace(re, (_m, body: string) => {
    const idx = planBlocks.push(body) - 1;
    return `\n\n${PLAN_FENCE_PLACEHOLDER_PREFIX}${idx}\n\n`;
  });
  const openMatch = /```plan\b[^\n]*\n([\s\S]*)$/.exec(text);
  if (openMatch) {
    const idx = planBlocks.push(openMatch[1]) - 1;
    text = text.slice(0, openMatch.index) +
      `\n\n${PLAN_FENCE_PLACEHOLDER_PREFIX}${idx}\n\n`;
  }
  return { text, planBlocks };
}

function injectPlanFenceCards(html: string, planBlocks: string[]): string {
  if (planBlocks.length === 0) return html;
  const re = new RegExp(
    `<p>\\s*${PLAN_FENCE_PLACEHOLDER_PREFIX}(\\d+)\\s*</p>`,
    "g",
  );
  return html.replace(re, (_m, idxStr: string) => {
    const idx = Number(idxStr);
    const body = planBlocks[idx] ?? "";
    const bodyHtml = marked.parse(body, { async: false }) as string;
    const bodyAttr = escapeAttr(body);
    return (
      `<div class="plan-draft-card" data-plan-draft-body="${bodyAttr}">` +
      `<div class="plan-draft-card-header">Plan draft — awaiting your approval</div>` +
      `<div class="plan-draft-card-body">${bodyHtml}</div>` +
      `<div class="plan-draft-card-actions">` +
      `<button type="button" class="plan-btn plan-draft-approve">Approve</button>` +
      `<button type="button" class="plan-btn plan-draft-edit">Edit</button>` +
      `<button type="button" class="plan-btn plan-draft-reject">Reject</button>` +
      `</div>` +
      `</div>`
    );
  });
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
