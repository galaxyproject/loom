/**
 * ULID minting for attempt ids.
 *
 * A ULID rather than a UUID because these ids get read by people in a
 * notebook diff and sorted by the tools that consume them: the first ten
 * characters are the timestamp in Crockford base32, so a lexical sort of
 * attempt ids is a chronological sort of submissions, and two attempts a
 * millisecond apart still differ in the 80 bits of randomness that follow.
 * Crockford base32 also has no vowels, so an id can't accidentally spell
 * something, and no visually confusable characters (no I, L, O, U).
 *
 * Deliberately not a dependency: this is thirty lines and adding a package to
 * the brain's runtime surface for it is not a good trade.
 */

import { randomBytes } from "crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/** Encode `value` as `length` Crockford base32 characters, most significant first. */
function encodeTime(value: number, length: number): string {
  let out = "";
  let remaining = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  // One byte per character, masked to 5 bits. Wasteful of entropy, not of
  // anything that matters -- 80 bits still comes out of a CSPRNG.
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CROCKFORD[bytes[i] & 0x1f];
  return out;
}

/**
 * Mint a ULID. `now` is injectable so tests can pin the time half.
 *
 * Timestamps beyond the 48-bit ceiling (year 10889) are rejected rather than
 * silently truncated into an id that sorts before every existing one.
 */
export function ulid(now: number = Date.now()): string {
  const time = Math.floor(now);
  if (!Number.isFinite(time) || time < 0 || time > 281474976710655) {
    throw new RangeError(`ulid: timestamp out of range: ${now}`);
  }
  return encodeTime(time, TIME_CHARS) + encodeRandom(RANDOM_CHARS);
}

const ULID_RE = new RegExp(`^[${CROCKFORD}]{${TIME_CHARS + RANDOM_CHARS}}$`);

export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}
