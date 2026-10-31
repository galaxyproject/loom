/** chokidar in the Orbit worker; see fs.ts. */
import { unavailable } from "./unavailable";

export const watch = unavailable("chokidar")("watch");
export default { watch };
