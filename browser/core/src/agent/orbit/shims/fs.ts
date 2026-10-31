/**
 * node:fs in the Orbit worker. The worker installs a profile with no files, so Orbit should never
 * call any of this; every function throws and names itself. Each is a named export, so a named
 * import of any of them builds (Node 22's fs function list).
 */
import { promises } from "./fs-promises";
import { unavailable } from "./unavailable";

const fail = unavailable("fs");

export const access = fail("access");
export const accessSync = fail("accessSync");
export const appendFile = fail("appendFile");
export const appendFileSync = fail("appendFileSync");
export const chmod = fail("chmod");
export const chmodSync = fail("chmodSync");
export const chown = fail("chown");
export const chownSync = fail("chownSync");
export const close = fail("close");
export const closeSync = fail("closeSync");
export const copyFile = fail("copyFile");
export const copyFileSync = fail("copyFileSync");
export const cp = fail("cp");
export const cpSync = fail("cpSync");
export const createReadStream = fail("createReadStream");
export const createWriteStream = fail("createWriteStream");
export const exists = fail("exists");
export const existsSync = fail("existsSync");
export const fchmod = fail("fchmod");
export const fchmodSync = fail("fchmodSync");
export const fchown = fail("fchown");
export const fchownSync = fail("fchownSync");
export const fdatasync = fail("fdatasync");
export const fdatasyncSync = fail("fdatasyncSync");
export const fstat = fail("fstat");
export const fstatSync = fail("fstatSync");
export const fsync = fail("fsync");
export const fsyncSync = fail("fsyncSync");
export const ftruncate = fail("ftruncate");
export const ftruncateSync = fail("ftruncateSync");
export const futimes = fail("futimes");
export const futimesSync = fail("futimesSync");
export const glob = fail("glob");
export const globSync = fail("globSync");
export const lchmod = fail("lchmod");
export const lchmodSync = fail("lchmodSync");
export const lchown = fail("lchown");
export const lchownSync = fail("lchownSync");
export const link = fail("link");
export const linkSync = fail("linkSync");
export const lstat = fail("lstat");
export const lstatSync = fail("lstatSync");
export const lutimes = fail("lutimes");
export const lutimesSync = fail("lutimesSync");
export const mkdir = fail("mkdir");
export const mkdirSync = fail("mkdirSync");
export const mkdtemp = fail("mkdtemp");
export const mkdtempDisposableSync = fail("mkdtempDisposableSync");
export const mkdtempSync = fail("mkdtempSync");
export const open = fail("open");
export const openAsBlob = fail("openAsBlob");
export const openSync = fail("openSync");
export const opendir = fail("opendir");
export const opendirSync = fail("opendirSync");
export const read = fail("read");
export const readFile = fail("readFile");
export const readFileSync = fail("readFileSync");
export const readSync = fail("readSync");
export const readdir = fail("readdir");
export const readdirSync = fail("readdirSync");
export const readlink = fail("readlink");
export const readlinkSync = fail("readlinkSync");
export const readv = fail("readv");
export const readvSync = fail("readvSync");
export const realpath = fail("realpath");
export const realpathSync = fail("realpathSync");
export const rename = fail("rename");
export const renameSync = fail("renameSync");
export const rm = fail("rm");
export const rmSync = fail("rmSync");
export const rmdir = fail("rmdir");
export const rmdirSync = fail("rmdirSync");
export const stat = fail("stat");
export const statSync = fail("statSync");
export const statfs = fail("statfs");
export const statfsSync = fail("statfsSync");
export const symlink = fail("symlink");
export const symlinkSync = fail("symlinkSync");
export const truncate = fail("truncate");
export const truncateSync = fail("truncateSync");
export const unlink = fail("unlink");
export const unlinkSync = fail("unlinkSync");
export const unwatchFile = fail("unwatchFile");
export const utimes = fail("utimes");
export const utimesSync = fail("utimesSync");
export const watch = fail("watch");
export const watchFile = fail("watchFile");
export const write = fail("write");
export const writeFile = fail("writeFile");
export const writeFileSync = fail("writeFileSync");
export const writeSync = fail("writeSync");
export const writev = fail("writev");
export const writevSync = fail("writevSync");

/** The access-mode bits, which Orbit reads at module scope. */
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export { promises };

export default {
  access,
  accessSync,
  appendFile,
  appendFileSync,
  chmod,
  chmodSync,
  chown,
  chownSync,
  close,
  closeSync,
  copyFile,
  copyFileSync,
  cp,
  cpSync,
  createReadStream,
  createWriteStream,
  exists,
  existsSync,
  fchmod,
  fchmodSync,
  fchown,
  fchownSync,
  fdatasync,
  fdatasyncSync,
  fstat,
  fstatSync,
  fsync,
  fsyncSync,
  ftruncate,
  ftruncateSync,
  futimes,
  futimesSync,
  glob,
  globSync,
  lchmod,
  lchmodSync,
  lchown,
  lchownSync,
  link,
  linkSync,
  lstat,
  lstatSync,
  lutimes,
  lutimesSync,
  mkdir,
  mkdirSync,
  mkdtemp,
  mkdtempDisposableSync,
  mkdtempSync,
  open,
  openAsBlob,
  openSync,
  opendir,
  opendirSync,
  read,
  readFile,
  readFileSync,
  readSync,
  readdir,
  readdirSync,
  readlink,
  readlinkSync,
  readv,
  readvSync,
  realpath,
  realpathSync,
  rename,
  renameSync,
  rm,
  rmSync,
  rmdir,
  rmdirSync,
  stat,
  statSync,
  statfs,
  statfsSync,
  symlink,
  symlinkSync,
  truncate,
  truncateSync,
  unlink,
  unlinkSync,
  unwatchFile,
  utimes,
  utimesSync,
  watch,
  watchFile,
  write,
  writeFile,
  writeFileSync,
  writeSync,
  writev,
  writevSync,
  constants,
  promises,
};
