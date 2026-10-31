/**
 * pi-tui in the Orbit worker. Orbit's tools return a `Text` from renderCall/renderResult for the
 * terminal; the worker never renders it, so this keeps only the text.
 */
export class Text {
  constructor(private text = "") {}
  setText(text: string): void {
    this.text = text;
  }
  setCustomBgFn(): void {}
  setPaddingX(): void {}
  invalidate(): void {}
  render(): string[] {
    return this.text.split("\n");
  }
}
