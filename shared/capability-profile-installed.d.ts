import type { CapabilityProfile } from "./capability-profile.js";

export function setCapabilityProfile(profile: CapabilityProfile | null): void;
/** The installed profile itself, or null when env is in charge. */
export function installedCapabilityProfile(): CapabilityProfile | null;
export const DEFAULT_AUTH_REMEDY: string;
/** The installed profile's auth remedy, or the Node shells' /connect. */
export function authRemedy(): string;
