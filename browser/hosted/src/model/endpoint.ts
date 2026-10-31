/**
 * Model access (brief H9): every worker calls one OpenAI-compatible endpoint -- TACC's directly, or
 * LiteLLM in front of it -- on Orbit's one service key, which reaches the worker in its workerData and
 * nowhere else. Users never see a key; each request names its user in the OpenAI `user` field, so an
 * endpoint that logs it (LiteLLM's spend log does) has a per-user usage ledger. Limits on the key
 * itself are the endpoint's to set.
 */
import type { WorkerData } from "../worker/protocol";

export interface ModelEndpointOptions {
  /** The endpoint's base URL; workers call `${url}/v1`. */
  readonly url: URL;
  readonly key: string;
  readonly model: string;
}

/** A user's model settings: the service's key and model, tagged with the user. */
export function endpointModels(
  options: ModelEndpointOptions,
): (sub: string) => WorkerData["model"] {
  const root = options.url.href.endsWith("/") ? options.url.href : `${options.url.href}/`;
  const baseUrl = new URL("v1", root).href;
  return (sub) => ({ baseUrl, id: options.model, apiKey: options.key, user: sub });
}
