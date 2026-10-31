/** node:os in the Orbit worker; see fs.ts. */
import { unavailable } from "./unavailable";

const fail = unavailable("os");

export const homedir = fail("homedir");
export const tmpdir = fail("tmpdir");
export const release = fail("release");
export const hostname = fail("hostname");
export const userInfo = fail("userInfo");
export const platform = (): string => "browser";
export const type = (): string => "Browser";
export const arch = (): string => "unknown";
export const EOL = "\n";

export default { homedir, tmpdir, release, hostname, userInfo, platform, type, arch, EOL };
