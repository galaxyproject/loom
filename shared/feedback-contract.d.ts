export declare const SCHEMA_VERSION: 1;
export declare const FEEDBACK_ROUTE: "/feedback";
export declare const FEEDBACK_KEY_HEADER: "X-Orbit-Feedback-Key";
export declare const FEEDBACK_ENDPOINT_URL: string;

export interface FeedbackSysinfo {
  appVersion?: string;
  platform?: string;
  arch?: string;
  electron?: string;
  chrome?: string;
  node?: string;
  llmProvider?: string;
  llmModel?: string;
  galaxyConfigured?: boolean;
}

export interface FeedbackPayload {
  schemaVersion: 1;
  source: "orbit" | "loom-cli";
  /**
   * Opaque beta-tester code (e.g. "orbit-007"), copied from LoomConfig.testerId.
   * MUST stay top-level: the orbit-feedback worker maps `payload.testerId` to a
   * first-class `tester_id` column. Optional + additive, so schemaVersion stays 1.
   */
  testerId?: string;
  title: string;
  body: string;
  sysinfo?: FeedbackSysinfo;
  activityTail?: string;
  shellTail?: string;
  clientTs: string;
}

export declare function validateFeedbackPayload(obj: unknown): obj is FeedbackPayload;

export interface FeedbackActivityEvent {
  timestamp: string;
  kind: string;
  source: string;
  payload?: Record<string, unknown>;
}

export declare function formatActivityTail(
  events: FeedbackActivityEvent[],
  opts?: { maxBytes?: number },
): string;

export declare function capFeedbackPayload(
  payload: FeedbackPayload,
  opts?: { maxTotalBytes?: number },
): FeedbackPayload;
