/**
 * Random bytes from the platform CSPRNG. Node 22+ (engines >=22.19) and workers
 * both have globalThis.crypto, so nothing here imports `crypto`, and the brain's
 * random ids need no Node edge.
 */

/** @param {number} n @returns {Uint8Array} */
export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** @param {number} n bytes @returns {string} 2n lowercase hex characters */
export function randomHex(n) {
  return Array.from(randomBytes(n), (b) => b.toString(16).padStart(2, "0")).join("");
}
