/**
 * node:url in the Orbit worker. lessons/validate.mjs calls fileURLToPath(import.meta.url) at module
 * scope, and in a worker that URL is http(s): or blob:, not file:, so any URL comes back as its
 * path rather than throwing; nothing reads the files it names.
 */
import { unavailable } from "./unavailable";

export function fileURLToPath(url: string | URL): string {
  return decodeURIComponent(new URL(String(url)).pathname);
}

export function pathToFileURL(path: string): URL {
  return new URL(`file://${encodeURI(path)}`);
}

export const parse = unavailable("url")("parse");

export default { fileURLToPath, pathToFileURL, parse, URL, URLSearchParams };
