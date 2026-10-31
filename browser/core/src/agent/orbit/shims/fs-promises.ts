/** node:fs/promises in the Orbit worker; see fs.ts. */
import { unavailable } from "./unavailable";

const fail = unavailable("fs/promises");

export const access = fail("access");
export const appendFile = fail("appendFile");
export const chmod = fail("chmod");
export const chown = fail("chown");
export const copyFile = fail("copyFile");
export const cp = fail("cp");
export const glob = fail("glob");
export const lchmod = fail("lchmod");
export const lchown = fail("lchown");
export const link = fail("link");
export const lstat = fail("lstat");
export const lutimes = fail("lutimes");
export const mkdir = fail("mkdir");
export const mkdtemp = fail("mkdtemp");
export const mkdtempDisposable = fail("mkdtempDisposable");
export const open = fail("open");
export const opendir = fail("opendir");
export const readFile = fail("readFile");
export const readdir = fail("readdir");
export const readlink = fail("readlink");
export const realpath = fail("realpath");
export const rename = fail("rename");
export const rm = fail("rm");
export const rmdir = fail("rmdir");
export const stat = fail("stat");
export const statfs = fail("statfs");
export const symlink = fail("symlink");
export const truncate = fail("truncate");
export const unlink = fail("unlink");
export const utimes = fail("utimes");
export const watch = fail("watch");
export const writeFile = fail("writeFile");

export const promises = {
  access,
  appendFile,
  chmod,
  chown,
  copyFile,
  cp,
  glob,
  lchmod,
  lchown,
  link,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  mkdtempDisposable,
  open,
  opendir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  writeFile,
};

export default promises;
