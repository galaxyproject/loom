// The profile a shell installed, apart from capability-profile.js and its env fallback, so the
// Galaxy tool path (which runs in the browser worker) can read what the shell said without an
// env read anywhere in its import graph. capability-profile.js re-exports all of it.

// Typed as CapabilityProfile in the .d.ts beside this file.
/** @type {Record<string, any> | null} */
let installed = null;

/**
 * The shell's own description of itself; null puts env back in charge.
 * @param {Record<string, any> | null} profile
 */
export function setCapabilityProfile(profile) {
  // A shell that predates a field gets the Node shells' value for it, so adding one changes no
  // existing caller.
  installed = profile ? { python: false, galaxy: "write", ...profile } : null;
}

/**
 * The installed profile itself (the same object capabilityProfile() returns),
 * or null when env is in charge.
 * @returns {Record<string, any> | null}
 */
export function installedCapabilityProfile() {
  return installed;
}

/** What every Node shell tells the model to ask for when Galaxy refuses the credentials. */
export const DEFAULT_AUTH_REMEDY = "Ask the user to run /connect";

/**
 * The installed profile's auth remedy, or the Node shells' /connect. Env never sets one, so the
 * installed profile is the whole answer.
 * @returns {string}
 */
export function authRemedy() {
  return installed?.authRemedy ?? DEFAULT_AUTH_REMEDY;
}
