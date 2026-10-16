export const DICTATION_SAMPLE_RATE = 16_000;
export const MAX_DICTATION_SECONDS = 120;
export const MAX_DICTATION_BYTES = 44 + DICTATION_SAMPLE_RATE * MAX_DICTATION_SECONDS * 2;

export interface DictationStatus {
  available: boolean;
  model: string;
  error?: string;
}

export type DictationResult =
  { ok: true; text: string } | { ok: false; error: string; cancelled?: boolean };

export interface DictationAPI {
  dictationStatus(): Promise<DictationStatus>;
  transcribeDictation(id: string, wav: ArrayBuffer): Promise<DictationResult>;
  cancelDictation(id: string): Promise<void>;
}
