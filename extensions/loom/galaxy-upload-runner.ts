import { execFile } from "child_process";

export interface UploadRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

export interface RunGalaxyUploadOpts {
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Run `uvx <args>` and collect output. Resolves for normal completion and for
 * AbortSignal cancellation; rejects only on spawn-level errors (e.g. ENOENT),
 * so the caller can map those to an actionable message.
 */
export function runGalaxyUpload(opts: RunGalaxyUploadOpts): Promise<UploadRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "uvx",
      opts.args,
      // 10MB headroom: with --silent output is tiny, but a chatty/retrying
      // transfer shouldn't trip ERR_CHILD_PROCESS_STDIO_MAXBUFFER and look like
      // a spawn failure.
      { env: opts.env, signal: opts.signal, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) {
          resolve({ exitCode: null, stdout: stdout ?? "", stderr: stderr ?? "", aborted: true });
          return;
        }
        // A string code (e.g. "ENOENT") is a spawn-level failure, not a process exit.
        if (e && typeof e.code === "string") {
          reject(e);
          return;
        }
        const exitCode = e && typeof e.code === "number" ? e.code : 0;
        resolve({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "", aborted: false });
      },
    );
  });
}
