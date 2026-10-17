export function utf8ByteLength(s: string): number;
export function truncateMiddle(
  content: string,
  maxBytes: number,
): {
  content: string;
  truncated: boolean;
  removedChars: number;
  totalBytes: number;
  totalLines: number;
};
