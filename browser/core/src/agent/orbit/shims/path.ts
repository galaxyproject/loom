/** node:path in the Orbit worker: pathe's POSIX implementation, which resolves against process.cwd(). */
import { posix } from "pathe";

export * from "pathe";
export default posix;
