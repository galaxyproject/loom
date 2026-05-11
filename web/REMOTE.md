# Orbit Web -- remote mode

A single-user, container-shaped Loom shell that operates exclusively against a Galaxy instance via env-injected credentials. No local filesystem, no `bash`, no `~/.loom/config.json`. The agent's only operating surface is Galaxy MCP, BRC-Analytics MCP, and a path-gated `edit`/`write`/`read` for the session `notebook.md`.

## Env contract

| Variable                                                         | Required                        | Notes                                       |
| ---------------------------------------------------------------- | ------------------------------- | ------------------------------------------- |
| `LOOM_MODE`                                                      | yes (`remote`)                  | Triggers shell-side curation                |
| `GALAXY_URL`                                                     | yes                             | Inherited to the brain                      |
| `GALAXY_API_KEY`                                                 | yes                             | Inherited to the brain                      |
| `LOOM_LLM_PROVIDER`                                              | no                              | Default `anthropic`; passed as `--provider` |
| `LOOM_LLM_MODEL`                                                 | no                              | Passed as `--model`                         |
| `ANTHROPIC_API_KEY` _or_ `XAI_API_KEY` _or_ `AI_GATEWAY_API_KEY` | yes (one of, matching provider) | Brain inherits as-is                        |
| `PORT`                                                           | no                              | Default 3000                                |
| `NODE_ENV`                                                       | no                              | `production` triggers static-bundle serving |

## Run

```bash
docker run --rm -p 3000:3000 \
  -e GALAXY_URL=https://usegalaxy.org \
  -e GALAXY_API_KEY=... \
  -e ANTHROPIC_API_KEY=... \
  orbit-web-remote:latest
```

Open `http://localhost:3000/`.

## Galaxy interactive tool

The same image is launchable as a Galaxy IT. The IT wrapper sets the env vars from the IT context (Galaxy injects `GALAXY_URL` and a signed scoped API key) and Galaxy proxies the user to the container. The wrapper itself is a separate piece of work and not bundled here.

## What's curated

- `bash` -- blocked outright
- `edit` / `write` / `read` -- restricted to `<cwd>/notebook.md` only
- `executionMode: local` -- forced to `cloud`
- `/connect` flow -- bypassed (creds env-injected)
- File-tree UI in the renderer -- hidden
