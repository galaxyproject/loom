import { MAX_DICTATION_SECONDS, type DictationAPI } from "../shared/dictation.js";
import { openMicrophone, type DictationRecorder } from "./dictation-recorder.js";

type State = "idle" | "starting" | "recording" | "transcribing";

/** Dictation edits the draft; it never submits a prompt or touches Loom. */
export class DictationController {
  private state: State = "idle";
  private available = false;
  private generation = 0;
  private controller?: AbortController;
  private recorder?: DictationRecorder;
  private requestId?: string;
  private clock?: ReturnType<typeof setInterval>;
  private limit?: ReturnType<typeof setTimeout>;
  private startedAt = 0;
  private draft = { value: "", start: 0, end: 0 };

  constructor(
    private readonly input: HTMLTextAreaElement,
    private readonly button: HTMLButtonElement,
    private readonly status: HTMLElement,
    private readonly api: Partial<DictationAPI>,
    private readonly busyChanged: (busy: boolean) => void = () => {},
    private readonly capture = openMicrophone,
  ) {
    if (!api.dictationStatus || !api.transcribeDictation || !api.cancelDictation) return;
    button.hidden = false;
    button.disabled = true;
    void api
      .dictationStatus()
      .then((result) => {
        this.available = result.available;
        button.disabled = !result.available;
        button.title = result.available
          ? "Dictate locally in English (⌘/Ctrl+Shift+M)"
          : result.error || "Dictation unavailable";
      })
      .catch(() => {
        button.title = "Local dictation is unavailable in this build.";
      });
    button.addEventListener("click", () => void this.toggle());
    input.ownerDocument.addEventListener(
      "keydown",
      (event) => {
        const shortcut =
          event.code === "KeyM" &&
          (event.metaKey || event.ctrlKey) &&
          event.shiftKey &&
          !event.altKey;
        if (shortcut && this.available) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void this.toggle();
        } else if (event.key === "Escape" && this.busy) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.cancel();
        }
      },
      true,
    );
    input.ownerDocument.defaultView?.addEventListener("pagehide", () => this.cancel());
  }

  get busy(): boolean {
    return this.state !== "idle";
  }

  private show(state: State, message: string): void {
    this.state = state;
    this.status.textContent = message;
    this.status.hidden = !message;
    this.button.dataset.state = state;
    this.button.setAttribute("aria-pressed", String(state === "recording"));
    this.button.setAttribute(
      "aria-label",
      state === "recording"
        ? "Finish dictation"
        : state === "starting" || state === "transcribing"
          ? "Cancel dictation"
          : "Dictate in English",
    );
    this.button.title =
      state === "recording"
        ? "Finish recording (⌘/Ctrl+Shift+M)"
        : this.busy
          ? "Cancel dictation (Esc)"
          : "Dictate locally in English (⌘/Ctrl+Shift+M)";
    this.busyChanged(this.busy);
  }

  private clearTimers(): void {
    if (this.clock) clearInterval(this.clock);
    if (this.limit) clearTimeout(this.limit);
    this.clock = undefined;
    this.limit = undefined;
  }

  async toggle(): Promise<void> {
    if (!this.available) return;
    if (this.state === "recording") return this.finish();
    if (this.busy) return this.cancel();
    const generation = ++this.generation;
    this.draft = {
      value: this.input.value,
      start: this.input.selectionStart,
      end: this.input.selectionEnd,
    };
    this.controller = new AbortController();
    this.show("starting", "Opening microphone… Click again or press Esc to cancel.");
    try {
      const recorder = await this.capture(this.controller.signal);
      if (generation !== this.generation) {
        recorder.cancel();
        return;
      }
      this.recorder = recorder;
      this.startedAt = Date.now();
      const tick = () => {
        const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
        this.show(
          "recording",
          `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · Click mic to finish · Esc to cancel`,
        );
      };
      tick();
      this.clock = setInterval(tick, 250);
      this.limit = setTimeout(() => void this.finish(), MAX_DICTATION_SECONDS * 1000);
    } catch (error) {
      if (generation !== this.generation) return;
      console.warn("[dictation] microphone capture failed:", error);
      this.controller?.abort();
      const denied =
        error instanceof Error && ["NotAllowedError", "PermissionDeniedError"].includes(error.name);
      this.show(
        "idle",
        denied
          ? "Microphone access was denied. Allow Orbit in your microphone settings."
          : "Couldn’t open the microphone. Check that a microphone is connected and available.",
      );
    }
  }

  private async finish(): Promise<void> {
    if (this.state !== "recording" || !this.recorder) return;
    const generation = this.generation;
    const recorder = this.recorder;
    this.recorder = undefined;
    this.clearTimers();
    this.show("transcribing", "Transcribing locally… Click mic or press Esc to cancel.");
    try {
      const wav = await recorder.stop();
      if (generation !== this.generation) return;
      this.requestId = crypto.randomUUID();
      const result = await this.api.transcribeDictation!(this.requestId, wav);
      if (generation !== this.generation) return;
      this.requestId = undefined;
      if (!result.ok) {
        this.show("idle", result.cancelled ? "Dictation cancelled." : result.error);
        return;
      }
      if (!result.text.trim()) {
        this.show("idle", "No speech detected. Try again closer to the microphone.");
        return;
      }
      // If typing changed the draft during transcription, insert at the current
      // caret without replacing any selection or overwriting those edits.
      const unchanged = this.input.value === this.draft.value;
      const start = unchanged ? this.draft.start : this.input.selectionEnd;
      const end = unchanged ? this.draft.end : start;
      const before = this.input.value.slice(0, start);
      const after = this.input.value.slice(end);
      const text =
        (before && !/\s$/.test(before) ? " " : "") +
        result.text.trim() +
        (after && !/^\s/.test(after) ? " " : "");
      this.input.value = before + text + after;
      const caret = before.length + text.length;
      this.input.setSelectionRange(caret, caret);
      this.input.dispatchEvent(
        new this.input.ownerDocument.defaultView!.Event("input", { bubbles: true }),
      );
      this.input.focus();
      this.show("idle", "Dictation added. Review your text, then Send.");
    } catch {
      if (generation === this.generation)
        this.show("idle", "Couldn’t transcribe this recording. Try again.");
    } finally {
      recorder.cancel();
    }
  }

  cancel(): void {
    if (!this.busy) return;
    ++this.generation;
    this.clearTimers();
    this.controller?.abort();
    this.recorder?.cancel();
    this.recorder = undefined;
    if (this.requestId) void this.api.cancelDictation?.(this.requestId).catch(() => {});
    this.requestId = undefined;
    this.show("idle", "Dictation cancelled.");
  }
}
