// pi-ai's bundled registry lists every model it has ever known per provider,
// including generations the provider's live API has since retired (e.g.
// gemini-2.0-flash, gemini-1.5-*). Those still appear in the picker via
// models:list-all but 404 the moment they're selected (#221). pi's Model carries
// no "deprecated" flag, so we filter on known-legacy id patterns. Keep this list
// tight and provider-scoped -- it only needs to drop clearly-superseded families,
// and a retired model that slips through is still caught at send time by the
// error-humanizer backstop.

const LEGACY_MODEL_PATTERNS: Record<string, RegExp[]> = {
  // Gemini 1.x and 2.0 are superseded by 2.5 / 3.x; the API rejects them.
  google: [/^gemini-1\./i, /^gemini-2\.0\b/i],
  // gpt-3.5, the original gpt-4-* (turbo/32k/dated), the o1 line, and the
  // legacy completion families are no longer the supported chat models.
  // Note: bare ids with no version suffix (e.g. plain `gpt-4`) deliberately
  // slip through here rather than risk matching a still-current family -- the
  // backstop catches them at send time. Don't "tighten" this to grab them.
  openai: [
    /^gpt-3\.5/i,
    /^gpt-4-turbo/i,
    /^gpt-4-32k/i,
    /^gpt-4-\d{3,}/i,
    /^o1(?:-|$)/i,
    /^text-/i,
    /^davinci/i,
    /^babbage/i,
  ],
};

export function isDeprecatedModelId(provider: string, id: string): boolean {
  const patterns = LEGACY_MODEL_PATTERNS[provider];
  if (!patterns) return false;
  return patterns.some((re) => re.test(id));
}
