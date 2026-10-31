/** Whether Galaxy answered when the session opened: what the worker says and the page shows. */
export const GALAXY_READY = "ok";
export const GALAXY_UNREACHABLE = "unreachable";
export type GalaxyStatus = typeof GALAXY_READY | typeof GALAXY_UNREACHABLE;
