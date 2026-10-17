/**
 * Where the brain's config comes from when not from ~/.loom/config.json: a
 * shell with no home directory (the browser worker) installs a source here and
 * loadConfig() reads it instead of the file. Node-free on purpose, so the
 * worker can install a source without loading the file backend.
 */

let installed = null;

/** @param {import("./config-source.js").ConfigSource | null} source */
export function setConfigSource(source) {
  installed = source;
}

export function installedConfigSource() {
  return installed;
}
