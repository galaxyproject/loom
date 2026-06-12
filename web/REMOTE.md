# Orbit Web -- remote mode

A single-user, container-shaped Loom shell that operates exclusively against a Galaxy instance via env-injected credentials. No local filesystem, no `bash`, no `~/.loom/config.json`. The agent's only operating surface is Galaxy MCP, BRC-Analytics MCP, and a path-gated `edit`/`write`/`read` for the session `notebook.md`.

## Env contract

| Variable                                                         | Required                        | Notes                                                           |
| ---------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------- |
| `LOOM_MODE`                                                      | yes (`remote`)                  | Triggers shell-side curation                                    |
| `GALAXY_URL`                                                     | yes                             | Inherited to the brain                                          |
| `GALAXY_API_KEY`                                                 | yes                             | Inherited to the brain                                          |
| `LOOM_LLM_PROVIDER`                                              | no                              | Default `anthropic`; passed as `--provider`                     |
| `LOOM_LLM_MODEL`                                                 | no                              | Passed as `--model`                                             |
| `ANTHROPIC_API_KEY` _or_ `XAI_API_KEY` _or_ `AI_GATEWAY_API_KEY` | yes (one of, matching provider) | Brain inherits as-is                                            |
| `PORT`                                                           | no                              | Default 3000                                                    |
| `LOOM_WEB_HOST`                                                  | no                              | Bind host. Default `127.0.0.1`; the image sets `0.0.0.0`        |
| `LOOM_WEB_TOKEN`                                                 | yes when exposed                | Shared secret; clients pass it as `?token=`                     |
| `LOOM_WEB_ALLOW_INSECURE`                                        | no                              | `1` to allow an exposed bind with no token (trusted proxy only) |
| `NODE_ENV`                                                       | no                              | `production` triggers static-bundle serving                     |

## Auth + exposure

The WebSocket drives a live agent against the injected Galaxy/LLM credentials, so an open port is an open agent. The server is fail-closed about this:

- It binds `127.0.0.1` by default. The container image sets `LOOM_WEB_HOST=0.0.0.0` so it's reachable via the published port.
- On any non-loopback bind it **refuses to start** unless `LOOM_WEB_TOKEN` is set (clients then pass `?token=<secret>`, and the WS upgrade is rejected without it) **or** `LOOM_WEB_ALLOW_INSECURE=1` is set for a deployment that's already behind a trusted reverse proxy / private network.
- WS upgrades are same-origin only, which blocks a drive-by page in the user's browser from opening a socket.

## Run

```bash
TOKEN=$(openssl rand -hex 32)
docker run --rm -p 3000:3000 \
  -e GALAXY_URL=https://usegalaxy.org \
  -e GALAXY_API_KEY=... \
  -e ANTHROPIC_API_KEY=... \
  -e LOOM_WEB_TOKEN="$TOKEN" \
  orbit-web-remote:latest
```

Open `http://localhost:3000/?token=$TOKEN`. (Behind a proxy that handles auth on its own, set `LOOM_WEB_ALLOW_INSECURE=1` instead of a token.)

## Galaxy interactive tool

The same image is launchable as a Galaxy IT. The IT wrapper sets the env vars from the IT context (Galaxy injects `GALAXY_URL` and a signed scoped API key) and Galaxy proxies the user to the container. The wrapper itself is a separate piece of work and not bundled here.

## What's curated

- `bash`, `grep`, `find`, `ls` -- blocked outright (no filesystem enumeration)
- `edit` / `write` / `read` -- restricted to `<cwd>/notebook.md` only
- `executionMode: local` -- forced to `cloud`
- `/connect` flow -- bypassed (creds env-injected)
- File-tree UI in the renderer -- hidden
