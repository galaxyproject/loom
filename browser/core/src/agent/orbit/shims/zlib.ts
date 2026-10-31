/** node:zlib in the Orbit worker; see fs.ts. */
import { unavailable } from "./unavailable";

const fail = unavailable("zlib");

export const gzipSync = fail("gzipSync");
export const gunzipSync = fail("gunzipSync");

export default { gzipSync, gunzipSync };
