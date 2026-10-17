/** The agent's config, assembled from where the page was launched and dev env vars. */
import { providerById } from "./agent/providers";
import type { Credentials } from "./credentials";

export interface Launched {
  root: string;
  datasetId?: string;
  /**
   * Galaxy's AI proxy, which the "galaxy" provider talks to. Galaxy serves one per visualization
   * plugin, so only a flavor it hosts that way has one; without it there is no "galaxy" provider.
   */
  galaxyChatUrl?: string;
}

export function buildConfig(incoming: Launched, creds?: Credentials | null) {
  const picked = creds ? providerById(creds.provider) : undefined;
  // The Galaxy proxy is the first-launch default where there is one, since it asks for no key;
  // elsewhere the picker has to be answered, so there is nothing to default to.
  const provider =
    creds?.provider ||
    (process.env.llm_provider as string) ||
    (incoming.galaxyChatUrl ? "galaxy" : undefined);
  return {
    // Dev routes through the vite proxy; a provider the agent defines carries its own base URL and
    // one pi defines is reached at pi's; the Galaxy chat proxy answers at the plugin's route.
    // A typed endpoint wins over the provider's own: it is how a self-hosted server is reached.
    ai_base_url:
      (process.env.llm_base_url as string) ||
      creds?.baseUrl?.trim() ||
      picked?.baseUrl ||
      (provider === "galaxy" ? incoming.galaxyChatUrl : undefined),
    ai_provider: provider,
    ai_model: creds?.model || (process.env.llm_model as string) || undefined,
    ai_context_window: Number(process.env.llm_context_window) || undefined,
    ai_keep_recent_tokens: Number(process.env.llm_keep_recent_tokens) || undefined,
    galaxy_root: incoming.root,
    dataset_id: incoming.datasetId,
  };
}
