export const HEAD_MAX_CHARS: number;
export const TAIL_MAX_CHARS: number;
export const ELISION_MARKER: string;
export function excerptHeadTail(content: string): { text: string; elided: boolean };
