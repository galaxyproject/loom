# Soak and fault harness

This runs the built host (`dist/host.mjs`) the way the dev stack does, against the stand-in Keycloak and the stand-in Galaxy and model (`src/auth/mock-oidc.ts`, `src/test-stand-in.ts`), on a throwaway `orbit_soak_<pid>_<n>` database over the local socket. Each simulated user signs in through the host's real `/auth/login` and `/auth/callback`, then talks over `/ws` as the page does. Nothing real is touched: no Galaxy, no model, no Keycloak.

```
cd browser/hosted
npm run build            # the harness runs dist/, so rebuild after changing src/
npm run soak             # everything: soak at N = 1, 4, 8, then every fault
npm run soak -- sigkill-mid-turn two-tabs        # just these
npm run soak -- soak --n 1,4,8,16 --turns 12     # just the soak, at these N
npm run soak -- postgres-blip --verbose          # with the host's log
```

The host listens on port 7931 (`--port`, 7900-8099). The run prints PASS or FAIL per scenario with its problems and numbers, writes everything to `.scratch/soak-<time>.json`, and exits non-zero if anything failed. The host runs with a 10 s lease TTL renewed every 3 s, so a dead host's lease runs out quickly; everything else is the production default.

## What it checks

The checks read the stored transcript, the stand-ins' request logs and the database rather than trusting what a page happened to receive. Every message carries a unique tag. A scenario passes when:

- each tag is in exactly one user entry, every tool call has exactly one result, and each run ends in exactly one answer (nothing lost, nothing duplicated);
- each destructive confirm is shown once per page and answered once, and Galaxy sees exactly one `PUT /api/histories/<id>` for an approved delete and none for a declined one;
- the conversation goes idle (no live loop, nothing in the inbox, not marked interrupted) and a later message still works.

The soak runs N users at once, each through a script that cycles through a history read, a plain question, an approved delete and a declined delete.

| fault | what happens |
|---|---|
| `sigkill-mid-turn`, `sigterm-mid-turn` | The host dies between a run's Galaxy read and the model's reply, then restarts. The run has to finish with no new message, and another user's turn right after the restart mustn't wait on it. |
| `sigterm-pending-confirm`, `sigkill-pending-confirm` | The host dies while a delete waits on its confirm. The old page's yes goes nowhere, and a new page is asked again. An answer, even a double click, deletes once. |
| `socket-drop` | The socket is cut mid-run and again mid-confirm. A new socket sees the run end and the same confirm. |
| `two-tabs` | Both tabs see the confirm. When one answers, the other's dialog closes, and a late click there does nothing. A turn started in one tab streams to the other. |
| `token-refresh-failure` | One user's Keycloak session is revoked while access tokens last 35 s. Their next Galaxy call never leaves, the model reads the sign-in wording, and the page's next message is turned away. Other users keep refreshing and working, and the revoked user can sign in again and carry on. |
| `kill-switch` | The host restarts with `ORBIT_TURNS_DISABLED` over a cut-off turn. Submits are refused with the notice, nothing reaches the model, and the cut turn waits. Once the switch is off, the turn resumes and the refused message never runs. |
| `postgres-blip` | `pg_terminate_backend` hits every host and worker connection while three runs wait on the model. The host stays up, every run finishes, and every conversation works afterwards. |
| `idle-release` | With `ORBIT_IDLE_RELEASE_SECONDS=2`, a conversation stays live while its page is open, and once the page closes its worker is released and the lease given back. Reopening it shows the stored transcript without starting a worker or calling the model. The next message boots a fresh worker (one lease generation up), with no greeting and nothing duplicated, and a delete after it asks and runs once. |
| `ask-pause` | With `ORBIT_ASK_PAUSE_SECONDS=3`, a delete's confirm goes unanswered. The page's dialog is withdrawn with a notice, a late yes from it does nothing, and the conversation is marked paused, not interrupted, with no worker. The user's other conversation runs at once meanwhile. Two tabs coming back at once each see the confirm once, and a yes deletes once. |

`postgres-blip` still fails now and then. A run whose pi-durable task fails on the dropped connection ends with `task_failed` and no answer. That issue is open; the other faults pass.

## Results, 2026-10-22

Measured on an Apple M4 Pro (24 GB) with Node v24.21.0. The machine was busy, with a load average of 5 to 7. The model is the stand-in, which answers at once, so the times are the service's own overhead. Workers are threads, so their memory is part of the host's RSS (sampled with `ps` every 100 ms).

| N users | host RSS idle / peak | first message to first model request | turn median (p95) |
|---|---|---|---|
| 1 | 78 / 232 MB | 726 ms | 496 ms (779) |
| 4 | 78 / 626 MB | 734 ms | 505 ms (787) |
| 8 | 78 / 975 MB | 757 ms | 389 ms (844) |
| 16 | 78 / 1745 MB | 922 ms | 315 ms (1088) |

- **Each live worker costs about 100 MB of host RSS** ((1745 - 78) / 16). These runs predate idle release, so workers stayed up after their turn.
- **Worker memory over a whole conversation:** one user, 40 turns. Host RSS rose from 215 to 247 MB over the first 20 turns (about 1.6 MB a turn), then fell back to 165-190 MB, and was 150-187 MB at the end. No steady growth showed.
- **Cold start:** the host listens 120-160 ms after spawn. A new conversation's first message takes about 0.73 s to reach the model. That covers the pg-boss poll (0.5 s interval), creating the Galaxy page and booting the worker.
- **Turn latency** at N = 1 is mostly dispatch. Submit to `run_start` takes 250-480 ms, because each turn waits on pg-boss's 0.5 s poll.
- **Galaxy requests per session:** 69 for 12 turns, or 5.8 a turn. 57 of them are `GET /api/pages/:id`, the notebook page re-read 4-5 times every turn. The rest: 3 history reads plus 3 contents, 3 deletes, 1 page create, 1 version and 1 `users/current`.
- **Leases:** the soak ends every conversation at lease generation 1, so one holder took it for the whole conversation, with no handoffs. A turn acquires-or-extends once. Each restart in the fault runs adds one generation.
- **Recovery after a restart:** a cut turn resumed 3.3 s after a SIGTERM restart and 48 s after a SIGKILL restart. That is the turn job's 30 s heartbeat, plus the 10 s monitor pass, plus a lease past its TTL. A pending confirm was asked again 0.2 s after SIGTERM and 45 s after SIGKILL. Another user's turn right after either restart took 0.8 s.
- **Idle release and the confirm pause** (added later the same day, with 2 s and 3 s settings): a released conversation's next message reached its answer in 0.74 s on a fresh worker, about one cold start. Host RSS fell only from 218 to 206 MB a second after the release; V8 keeps a finished thread's heap for a while, so the saving shows under load rather than at once. A confirm left unanswered was withdrawn 3.7 s after it was asked (the 3 s setting plus the check interval), the user's other conversation ran in 0.76 s meanwhile, and coming back asked again in 0.4 s.
- **Long, tool-heavy conversations slow down:** past about 30 model requests a minute, every model request waits 2 s. Core's per-model client rate limiter defaults to 30 a minute (`core/src/agent/model.ts`), and the hosted worker leaves it on.
