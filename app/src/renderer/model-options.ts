/** One entry in the Preferences model dropdown. */
export interface ModelOption {
  id: string;
  label: string;
  selected: boolean;
}

/**
 * Build the model dropdown's options from a list of ids discovered at an
 * OpenAI-compatible endpoint's /models.
 *
 * The saved model is always kept, even when the endpoint no longer lists it:
 * dropping it would leave the <select> defaulting to whichever id came back
 * first, silently reconfiguring the model the user chose.
 */
export function buildDiscoveredModelOptions(
  discovered: readonly string[],
  selected?: string,
): ModelOption[] {
  const wanted = selected?.trim() || "";
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const raw of discovered) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label: id, selected: id === wanted });
  }
  if (wanted && !seen.has(wanted)) {
    options.push({ id: wanted, label: `${wanted} (custom)`, selected: true });
  }
  return options;
}
