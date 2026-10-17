// The version token of a Galaxy page as the record store sees it. Galaxy's page PUT carries no
// precondition and its GET no etag, so the client hashes the body it read and compares before it
// writes. Must stay byte-identical to galaxy-ops' `contentHash`: the model's own `update_page`
// in the browser compares against that function, and the two sides have to agree on what "the
// page I was shown" is. browser/core/src/agent/page-content-hash.test.ts is the tripwire.

/** djb2 over the code points of a page body, as eight hex digits.
 * @param {string} body @returns {string} */
export function pageContentHash(body) {
  let h = 5381;
  for (const c of body) h = (h * 33 + c.codePointAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0");
}
