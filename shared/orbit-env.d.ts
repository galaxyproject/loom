type EnvLike = Record<string, string | undefined>;

export const WARN_ON_LEGACY_ENV: boolean;
export const DESKTOP_SHELL_KIND: "orbit";

export function currentEnvName(name: string): string;
export function legacyEnvNames(name: string): string[];
export function envNames(name: string): string[];
export function readEnv(name: string, env?: EnvLike): string | undefined;
export function writeEnv(env: EnvLike, name: string, value: string): void;
export function mirrorToLegacyEnv(env: EnvLike, name: string): void;
export function isDesktopShell(env?: EnvLike): boolean;
export function _setLegacyEnvWarnings(enabled: boolean): void;
