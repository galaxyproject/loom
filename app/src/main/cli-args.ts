export interface CliArgs {
  cwd?: string;
}

/**
 * Parse the switches Orbit accepts out of an argv array.
 *
 * Scans the WHOLE array rather than assuming user args begin at a fixed index.
 * Electron's argv shape differs between dev and packaged builds -- `electron .
 * --cwd x` puts the app path at index 1 (user args at 2), while a packaged
 * `orbit --cwd x` has user args at index 1 -- and the `second-instance` event
 * delivers yet another full argv. A position-independent scan handles all three
 * without a slice that's only correct in one of them. The exec path / app-path /
 * Electron flags are never literally `--cwd`, so scanning from the start is safe.
 *
 * Recognized: `--cwd <path>`. Everything else is ignored.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd" && i + 1 < argv.length) {
      out.cwd = argv[i + 1];
      i++;
    }
  }
  return out;
}
