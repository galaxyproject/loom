export interface WslRuntimeInfo {
  /** Node's `process.platform`. */
  platform?: string;
  /** Node's `process.env` (or any subset of it). */
  env?: Record<string, string | undefined>;
  /** Node's `os.release()`. */
  release?: string;
}

export declare function isWsl(runtime?: WslRuntimeInfo): boolean;
