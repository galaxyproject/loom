import { isWsl } from "../../../shared/wsl.js";

/** Runtime facts the envelope is built from. Injected so this stays testable. */
export interface ReportSysinfoRuntime {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: string;
  arch: string;
  env: Record<string, string | undefined>;
  release: string;
}

/**
 * What `report:sysinfo` hands the renderer. Field names differ from the wire
 * shape (electronVersion vs electron); the renderer maps them in
 * toFeedbackSysinfo. `wsl` is resolved here because the renderer can see
 * neither the environment nor os.release().
 */
export interface ReportSysinfoEnvelope {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: string;
  arch: string;
  wsl: boolean;
}

export function buildReportSysinfo({
  env,
  release,
  ...info
}: ReportSysinfoRuntime): ReportSysinfoEnvelope {
  return { ...info, wsl: isWsl({ platform: info.platform, env, release }) };
}
