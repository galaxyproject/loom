export declare function hasStoredCredential(
  auth: Record<string, unknown> | undefined,
  provider: string,
): boolean;

export declare function isProviderUsable(
  provider: string,
  entry: { apiKey?: string } | undefined,
  auth: Record<string, unknown> | undefined,
  opts?: {
    env?: Record<string, string | undefined>;
    oauthOnlyProviders?: ReadonlySet<string>;
    providerEnvMap?: Record<string, string>;
    customKeyResolved?: string | undefined;
  },
): boolean;

export declare function pickSignedInFallback(
  auth: Record<string, unknown> | undefined,
  oauthOnlyProviders: Iterable<string>,
  current: string,
): string | null;
