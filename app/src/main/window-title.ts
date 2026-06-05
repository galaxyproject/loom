const APP_NAME = "Orbit";

/**
 * Window title for #190: the working directory, home-abbreviated to "~/...".
 * Showing the path (not just the folder name) keeps two same-named project
 * dirs in different locations distinguishable -- the cross-project confusion
 * the issue is about. Bare app name when no cwd is set yet.
 */
export function formatWindowTitle(cwd: string, home: string): string {
  if (!cwd) return APP_NAME;
  return `${abbreviateHome(cwd, home)} — ${APP_NAME}`;
}

function abbreviateHome(cwd: string, home: string): string {
  if (!home) return cwd;
  // Compare with trailing separators stripped so "/home/x/" matches "/home/x".
  // Require a separator right after `home` so "/home/xtra" isn't read as inside
  // "/home/x". Accept either separator (so posix paths abbreviate on Windows
  // too) and slice rather than rebuild to keep the original one.
  const c = cwd.replace(/[/\\]+$/, "");
  const h = home.replace(/[/\\]+$/, "");
  if (c === h) return "~";
  if (c.startsWith(h) && (c[h.length] === "/" || c[h.length] === "\\")) {
    return "~" + c.slice(h.length);
  }
  return cwd;
}
