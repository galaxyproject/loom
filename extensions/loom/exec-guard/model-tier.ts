import type { ModelTier } from "./types";

export interface TierInput {
  id?: string;
  provider?: string;
  cost?: { input: number; output: number };
}

// Substrings that mark a model as weak/cheap regardless of cost. Matched
// case-insensitively against the model id. Conservative: when unsure -> weak.
const WEAK_ID_MARKERS = ["haiku", "mini", "flash", "small", "lite", "8b", "7b", "1b", "3b", "nano"];

// Frontier id markers that are trusted even if a custom price table is wrong.
const TRUSTED_ID_MARKERS = [
  "opus",
  "sonnet",
  "gpt-5",
  "gpt-4.1",
  "o1",
  "o3",
  "gemini-2.5-pro",
  "gemini-1.5-pro",
];

export function classifyModelTier(model: TierInput | undefined): ModelTier {
  if (!model || !model.id) return "weak";
  const id = model.id.toLowerCase();
  if (WEAK_ID_MARKERS.some((m) => id.includes(m))) return "weak";
  if (TRUSTED_ID_MARKERS.some((m) => id.includes(m))) return "trusted";
  // Fall back to price: frontier output pricing is well above cheap tiers.
  // Threshold chosen so Haiku ($5 out) is weak and Sonnet ($15 out) is trusted.
  const out = model.cost?.output ?? 0;
  return out >= 10 ? "trusted" : "weak";
}
