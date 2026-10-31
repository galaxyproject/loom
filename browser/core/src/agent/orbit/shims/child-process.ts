/** node:child_process in the Orbit worker; see fs.ts. */
import { unavailable } from "./unavailable";

const fail = unavailable("child_process");

export const execFileSync = fail("execFileSync");
export const execFile = fail("execFile");
export const execSync = fail("execSync");
export const exec = fail("exec");
export const spawn = fail("spawn");
export const spawnSync = fail("spawnSync");

export default { execFileSync, execFile, execSync, exec, spawn, spawnSync };
