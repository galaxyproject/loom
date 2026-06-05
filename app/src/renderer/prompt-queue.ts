export const QUEUED_PREVIEW_LIMIT = 80;

export function queuedPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= QUEUED_PREVIEW_LIMIT) return normalized;
  return normalized.slice(0, QUEUED_PREVIEW_LIMIT - 1) + "\u2026";
}

export class PromptQueue {
  private pending: string[] = [];
  private isCollapsed = false;

  get items(): readonly string[] {
    return this.pending;
  }

  get length(): number {
    return this.pending.length;
  }

  get collapsed(): boolean {
    return this.isCollapsed;
  }

  enqueue(text: string): void {
    const previousLength = this.pending.length;
    this.pending.push(text);
    this.syncCollapseAfterChange(previousLength);
  }

  remove(index: number): void {
    if (index < 0 || index >= this.pending.length) return;
    const previousLength = this.pending.length;
    this.pending.splice(index, 1);
    this.syncCollapseAfterChange(previousLength);
  }

  clear(): void {
    this.pending = [];
    this.isCollapsed = false;
  }

  flushNext(): string | undefined {
    const previousLength = this.pending.length;
    const text = this.pending.shift();
    if (text === undefined) return undefined;
    this.syncCollapseAfterChange(previousLength);
    return text;
  }

  toggleCollapsed(): void {
    if (this.pending.length === 0) return;
    this.isCollapsed = !this.isCollapsed;
  }

  private syncCollapseAfterChange(previousLength: number): void {
    if (this.pending.length <= 2) {
      this.isCollapsed = false;
    } else if (previousLength <= 2) {
      this.isCollapsed = true;
    }
  }
}
