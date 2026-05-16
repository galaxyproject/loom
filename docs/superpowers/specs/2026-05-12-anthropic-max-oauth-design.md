# Anthropic Max OAuth — Design

**Date:** 2026-05-12
**Status:** Approved for planning
**Scope:** Add Anthropic Pro/Max account sign-in to Orbit alongside the existing API-key flow.

## Background

Orbit currently authenticates LLM calls via a per-provider API key stored in
Orbit's encrypted config (`apiKeyEncrypted`, Electron `safeStorage`) and passed
to the brain as `ANTHROPIC_API_KEY`. Anthropic Pro/Max subscribers don't have
an API key — they authenticate via OAuth (PKCE) to claude.ai and use bearer
tokens against `api.anthropic.com` with the `anthropic-beta: oauth-2025-04-20`
header.

Two upstream pieces solve most of the transport problem:

- `@mariozechner/pi-ai` ships `utils/oauth/anthropic.js`, a complete login
  flow (PKCE, callback server on `http://localhost:53692/callback`, refresh).
- `@mariozechner/pi-coding-agent` natively reads OAuth credentials from
  `<PI_AGENT_DIR>/auth.json` (default `~/.pi/agent/auth.json`) and refreshes
  lazily on 401.

Orbit already depends on both. The work is UI, config plumbing, and brain-
spawn glue — not new transport code.

## Decisions (from brainstorming)

1. **Auth coexistence** — one-or-the-other per provider. Sign-in clears the
   API key; sign-out reverts to API-key mode.
2. **Token storage** — Orbit's `safeStorage` is the source of truth.
   Decrypted `auth.json` is written to a session-scoped temp dir on brain
   spawn and read back on brain exit to capture refreshed tokens.
3. **Sign-in UX** — modal with live status + paste-the-code fallback.
4. **Refresh** — brain refreshes lazily via pi-ai. Orbit doesn't run a timer.
5. **Multi-account** — single account in v1.
6. **Sign-out with brain alive** — blocked; user must stop brain first.

## Architecture

### Config schema (`shared/loom-config.d.ts`)

```ts
llm?: {
  provider?: string;
  authMode?: "apiKey" | "oauth";    // new; default "apiKey"
  apiKey?: string;
  apiKeyEncrypted?: string;
  oauthEncrypted?: string;          // safeStorage(base64) of OAuthCredentials JSON
  oauthAccountLabel?: string;       // display string, e.g. "anton@nekrut.org"
  model?: string;
};
```

`authMode` is the single source of truth. Switching modes clears the inactive
slot — `oauth → apiKey` clears `oauthEncrypted`/`oauthAccountLabel`,
`apiKey → oauth` clears `apiKeyEncrypted`/`apiKey`.

### OAuth flow (`app/src/main/anthropic-oauth.ts`, new)

Runs in Electron's main process. Imports `loginAnthropic` from
`@mariozechner/pi-ai/dist/utils/oauth/anthropic.js`.

```
signIn({ onStatus }): Promise<{ creds: OAuthCredentials, accountLabel: string }>
  1. Call pi-ai's loginAnthropic with bridge callbacks.
  2. onAuth({ url }) → shell.openExternal(url); emit status "browser" with URL.
  3. pi-ai runs callback server on 127.0.0.1:53692, awaits redirect, validates
     state + PKCE, exchanges code for tokens.
  4. Derive accountLabel from JWT claim (account email or accountId).
  5. Return { creds, accountLabel }. Caller encrypts and persists.

signOut(): void
  Clears oauthEncrypted + oauthAccountLabel via the existing config write path.
  (Brain-alive guard lives in the IPC handler, not here.)
```

Port 53692 is hardcoded by pi-ai. If unavailable, surface the error to the
modal and instruct the user to retry (only one in-flight login at a time).

Paste-the-code fallback: a second IPC route feeds a user-supplied code into
pi-ai's flow via the `onManualCodeInput` callback. pi-ai races the callback
server and the manual input — whichever resolves first wins.

### Brain spawn integration (`app/src/main/agent.ts`)

Existing logic at `app/src/main/agent.ts:13` maps provider →
`<PROVIDER>_API_KEY` env var. Branch on `authMode`:

```
On brain spawn:
  if cfg.llm.authMode === "oauth":
    1. Decrypt cfg.llm.oauthEncrypted via safeStorage → OAuthCredentials JSON.
    2. Make session-scoped temp dir: ~/.loom/run/<pid>/pi/
    3. Write auth.json there in the shape pi-coding-agent expects:
         { anthropic: { type: "oauth", credentials: {...} } }
    4. Spawn brain with env.PI_AGENT_DIR = ~/.loom/run/<pid>/pi
       Do NOT set ANTHROPIC_API_KEY.
  else (authMode === "apiKey"):
    Existing path — set ANTHROPIC_API_KEY from decrypted apiKeyEncrypted.

On brain exit (clean or crash):
  if oauth was used:
    1. Read auth.json back from the temp dir.
    2. If credentials differ from what we wrote (pi-ai refreshed),
       re-encrypt and save to cfg.llm.oauthEncrypted.
    3. rm -rf the temp dir.
```

`PI_AGENT_DIR` is honored by pi-coding-agent's `getAgentDir()` in
`node_modules/@mariozechner/pi-coding-agent/dist/config.js:359` (env var
name verified during exploration).

The per-session temp dir isolates Orbit's pi-agent state from any standalone
pi-coding-agent install. Read-back on exit is best-effort — if Orbit crashes
before reading, the next session uses slightly stale tokens and pi-ai
refreshes again.

### UI (renderer)

Settings panel — Anthropic provider section, two-state driven by `authMode`:

```
authMode === "apiKey":
  [API Key]  [········]  [Sign in with Claude →]
  Help text: "Or use your Claude Pro/Max account."

authMode === "oauth":
  Signed in as anton@nekrut.org   [Sign out]
  (API key field hidden.)
```

Sign-in modal (new component `app/src/renderer/oauth-modal.ts`):

```
┌─ Sign in with Claude ─────────────────────────┐
│                                                │
│  ▸ Opening browser…                            │
│  ✓ Browser opened                              │
│  ⋯ Waiting for authorization (port 53692)…    │
│                                                │
│  Browser didn't open? Open this URL:           │
│  https://claude.ai/oauth/authorize?…           │
│                                                │
│  Or paste the authorization code:              │
│  [_______________________________] [Submit]    │
│                                                │
│                                       [Cancel] │
└────────────────────────────────────────────────┘
```

Status lines stream from main via the `auth:oauth:status` event channel.
On success, modal flips to a 1-second "✓ Signed in as <label>" then closes
and triggers a settings-panel refresh.

Sign-out button: pre-flight checks brain state via `AgentManager.isRunning()`
(add if not exposed). If alive, button is disabled with tooltip "Stop the
running brain first." Otherwise: confirm → clear tokens → settings re-renders.

### IPC contract (`app/src/main/ipc-handlers.ts`)

```
Request/response:
  auth:oauth:signin          → { ok: true, accountLabel } | { ok: false, error }
  auth:oauth:paste { code }  → feeds code into in-flight login
  auth:oauth:cancel          → tears down callback server, aborts flow
  auth:oauth:signout         → fails if brain alive; else clears oauth slot

Event (main → renderer):
  auth:oauth:status { stage, message?, url? }
    stage ∈ "opening" | "browser" | "waiting" | "exchanging" | "success" | "error"
```

Config persistence reuses the existing `config:save` path. The merge logic in
`ipc-handlers.ts:65–103` gets a parallel branch for `oauthEncrypted`
mirroring how `apiKeyEncrypted` is preserved across saves and how
`UNCHANGED_SECRET` works.

## Testing

```
tests/anthropic-oauth.test.ts (new)
  - Token round-trip: encrypt OAuthCredentials via mock safeStorage, decrypt
    back, assert shape preserved (access/refresh/expires/accountId).
  - auth.json writer: given mock creds, writes pi-coding-agent-expected shape
    at <tmp>/auth.json. Snapshot the JSON structure.
  - Read-back on brain exit: writes auth.json, simulates a refresh (different
    access token), reads it back, asserts updated tokens persist.

tests/config-merge-oauth.test.ts (new)
  - Saving a config with authMode flip apiKey → oauth clears apiKeyEncrypted.
  - Inverse: oauth → apiKey clears oauthEncrypted + oauthAccountLabel.
  - UNCHANGED_SECRET sentinel works for oauthEncrypted.
```

Manual smoke (documented in PR description, not automated):

- Sign-in modal end-to-end against a real Max account (callback path).
- Paste-code fallback.
- Sign-out blocked while brain alive; allowed after stop.
- Brain spawn with oauth mode; `ANTHROPIC_API_KEY` confirmed absent in env.

Not tested: pi-ai's PKCE/state validation (upstream's job), Anthropic's real
OAuth server (not reachable from CI), Electron's safeStorage on a headless
box (no keyring).

## Out of scope (v1)

- Multiple Max accounts / account switcher.
- OAuth for non-Anthropic providers (pi-ai supports OpenAI Codex etc.;
  separate pass).
- Proactive token refresh in Orbit.
- Mid-pipeline sign-out / coexistence with revoked tokens.
- Billing/usage surfaces ("you're on Max, Sonnet costs N tokens").
- Token revocation API call on sign-out (we just delete locally).

## Files touched

```
shared/loom-config.d.ts                    — extend LoomConfig.llm shape
app/src/main/anthropic-oauth.ts            — new; signIn/signOut
app/src/main/ipc-handlers.ts               — new auth:oauth:* routes + merge logic
app/src/main/agent.ts                      — authMode branch on spawn + read-back on exit
app/src/renderer/oauth-modal.ts            — new; sign-in modal
app/src/renderer/app.ts                    — settings panel two-state surface
tests/anthropic-oauth.test.ts              — new
tests/config-merge-oauth.test.ts           — new
```

## Open questions for plan stage

- Exact JSON shape pi-coding-agent expects in `auth.json` — verify by reading
  its `auth-storage.js` schema before writing the test snapshot.
- Whether `AgentManager` already exposes a public `isRunning()` query or
  whether we need to add one.
- Account-label derivation — JWT claim path vs. a `/v1/me`-style call;
  whichever pi-ai already does, mirror it.
