/**
 * A bounded stack of "what the document looked like before".
 *
 * The dashboard has three writers -- the user through this editor, a widget
 * changing its own config, and the brain -- and the person watching cannot read
 * JSON or diff two layouts. Undo is how they get back, so it covers changes the
 * editor did not make as well as the ones it did.
 *
 * Each entry is a whole document rather than a diff: the document is small, a
 * snapshot cannot be misapplied to a state it was not taken from, and undoing
 * a remove after two unrelated edits still does the right thing.
 */

export interface UndoEntry<T> {
  /** What the user would be undoing, in their words: `Removed "Plan"`. */
  label: string;
  /** The document as it was before that change. */
  state: T;
  /**
   * Who made the change this entry reverses. A change the editor did not make
   * is the one the user most needs told about, so it is surfaced even when
   * they are not editing.
   */
  source: UndoSource;
}

/**
 * Who made the change. `external-config` is a widget saving its own config --
 * almost always the person's own click on a control in a panel header -- and is
 * kept apart from `external` so that it does not interrupt them with a notice
 * about something they just did.
 */
export type UndoSource = "editor" | "external" | "external-config";

export const DEFAULT_UNDO_DEPTH = 20;

export class UndoStack<T> {
  private entries: UndoEntry<T>[] = [];

  constructor(private capacity: number = DEFAULT_UNDO_DEPTH) {
    if (!Number.isFinite(capacity) || capacity < 1) this.capacity = 1;
  }

  /** Record the state a change is about to replace. The oldest entry falls off. */
  push(label: string, state: T, source: UndoSource = "editor"): void {
    this.entries.push({ label, state, source });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  /** The most recent entry, removed. Null when there is nothing to undo. */
  pop(): UndoEntry<T> | null {
    return this.entries.pop() ?? null;
  }

  /** The most recent entry, left in place. For labelling the Undo control. */
  peek(): UndoEntry<T> | null {
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }

  get size(): number {
    return this.entries.length;
  }

  get canUndo(): boolean {
    return this.entries.length > 0;
  }

  clear(): void {
    this.entries = [];
  }
}
