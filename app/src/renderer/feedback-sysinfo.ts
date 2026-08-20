import type { FeedbackSysinfo } from "../../../shared/feedback-contract.js";
// Type-only, so this adds no main→renderer runtime coupling (same shape as
// galaxy-tooltip.ts importing GalaxyUserStatus).
import type { ReportSysinfoEnvelope } from "../main/report-sysinfo.js";

/** The slice of LoomConfig the report needs. */
export interface FeedbackConfigView {
  llm?: { active?: string; providers?: Record<string, { model?: string }> };
  galaxy?: { active: string | null };
}

/**
 * Orbit's FeedbackSysinfo builder -- the shell-side counterpart to the brain's
 * buildBrainSysinfo(). DOM-free so it stays testable outside Electron. Carries
 * no cwd and no credentials.
 */
export function toFeedbackSysinfo(
  info: ReportSysinfoEnvelope,
  cfg: FeedbackConfigView,
): FeedbackSysinfo {
  const active = cfg.llm?.active;
  return {
    appVersion: info.appVersion,
    platform: info.platform,
    arch: info.arch,
    wsl: info.wsl,
    electron: info.electronVersion,
    chrome: info.chromeVersion,
    node: info.nodeVersion,
    llmProvider: active,
    llmModel: active ? cfg.llm?.providers?.[active]?.model : undefined,
    galaxyConfigured: Boolean(cfg.galaxy?.active),
  };
}
