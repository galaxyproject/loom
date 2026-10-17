// Byte-bounded head + tail cut of tool output, the same cut pi 1.1.0 makes for its own tool results
// (`dist/core/tools/truncate.js` truncateMiddle). Ported over TextEncoder rather than imported: that
// file is a deep dist import, and it uses Node's byte buffers, which the browser worker lacks.

const encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF in the head or tail, as pi's Node decode does.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * UTF-8 length of `s` without encoding it. A lone surrogate counts as 3 bytes, the U+FFFD that
 * TextEncoder (and Node's byteLength) write in its place.
 * @param {string} s @returns {number}
 */
export function utf8ByteLength(s) {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** @param {string} content @returns {number} */
function lineCount(content) {
  if (content.length === 0) return 0;
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines.length;
}

/**
 * Keep the first and last halves of `maxBytes` and replace the middle with a
 * `…N chars truncated…` marker. Cuts only at character boundaries.
 * @param {string} content @param {number} maxBytes
 * @returns {{ content: string, truncated: boolean, removedChars: number, totalBytes: number, totalLines: number }}
 */
export function truncateMiddle(content, maxBytes) {
  const buf = encoder.encode(content);
  const totalLines = lineCount(content);
  if (buf.length <= maxBytes) {
    return { content, truncated: false, removedChars: 0, totalBytes: buf.length, totalLines };
  }
  // Continuation bytes (10xxxxxx) never start a character.
  const isBoundary = (/** @type {number} */ index) =>
    index >= buf.length || (buf[index] & 0xc0) !== 0x80;
  let headEnd = Math.floor(maxBytes / 2);
  while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
  let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
  while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
  const head = decoder.decode(buf.subarray(0, headEnd));
  const tail = decoder.decode(buf.subarray(tailStart));
  const removedChars = Array.from(decoder.decode(buf.subarray(headEnd, tailStart))).length;
  return {
    content: `${head}…${removedChars} chars truncated…${tail}`,
    truncated: true,
    removedChars,
    totalBytes: buf.length,
    totalLines,
  };
}
