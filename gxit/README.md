# Orbit as a Galaxy Interactive Tool

Runs the remote Orbit web shell (`LOOM_MODE=remote`) as a per-user Galaxy
Interactive Tool. The same container image runs standalone (`docker run`) or as a
GxIT; this directory is the Galaxy-side wrapper that launches it per user, injects
a scoped API key, and proxies the user in.

Requires the instance to have interactive tools enabled (gx-it-proxy + a
Docker/Podman-capable job destination).

## 1. Build the image

From the repo root:

```bash
docker build -t quay.io/galaxyproject/orbit:0.1.0 .   # or any tag
# docker push quay.io/galaxyproject/orbit:0.1.0        # for a shared instance
```

Set that exact tag in `interactivetool_orbit.xml`'s `<container>` (replace `TAG`).
For a **local dev Galaxy**, you can skip the registry: build a local tag (e.g.
`docker build -t orbit:dev .`) and point `<container>` at `orbit:dev` — the local
Docker daemon already has it.

## 2. Register the tool

- Add `interactivetool_orbit.xml` to the instance's tool config (a
  `<tool file="/path/to/gxit/interactivetool_orbit.xml" />` entry in
  `tool_conf.xml`, or via `config/tool_conf.xml.sample` → `tool_conf.xml`).
- Enable interactive tools in `config/galaxy.yml` (`galaxy:` section):
  `interactivetools_enable: true` and an `interactivetools_map`. Configure and run
  `gx-it-proxy` (`gravity:` section has a `gx_it_proxy:` block; `galaxy.yml.interactivetools`
  and `job_conf.yml.interactivetools` in `config/` are ready-made templates).
- Route the tool to a Docker-enabled destination in `job_conf` (interactive tools
  must run with `docker_enabled` / `podman` — see `job_conf.yml.interactivetools[.podman]`).

## 3. Supply the admin LLM key (secret)

Set the provider key on the IT's **job destination env** in `job_conf` — NOT in the
tool XML — so it never lands in a committed/shared file. For a YAML `job_conf`:

```yaml
orbit_destination:
  runner: local_docker # or your docker/podman runner
  docker_enabled: true
  env:
    - name: ANTHROPIC_API_KEY
      value: "sk-ant-..." # or another provider's key
    # - name: LOOM_LLM_PROVIDER
    #   value: anthropic
```

If no admin key is provided, the user is prompted for their own once BYO-key
(Plan 2) lands. (For a free/local model, see "Custom provider" below.)

### Custom OpenAI-compatible provider (e.g. a local/free endpoint)

The brain reads a custom provider's `baseUrl` from `~/.loom/config.json` inside the
container and resolves the key from `LOOM_ACTIVE_LLM_API_KEY`. To use one, bake a
`~/.loom/config.json` into a derived image (or mount one) with:

```json
{
  "llm": {
    "active": "myprov",
    "providers": { "myprov": { "baseUrl": "https://host/v1", "model": "model-id" } }
  }
}
```

and inject `LOOM_ACTIVE_LLM_API_KEY` via the destination env.

## 4. Trust model

`LOOM_WEB_ALLOW_INSECURE=1` (set in the tool XML) is safe here: gx-it-proxy
authenticates the Galaxy user and routes only them to their container; the
container is not otherwise reachable, and a Galaxy-controlled entry-point URL
can't carry `LOOM_WEB_TOKEN`. The agent receives a **scoped** per-user key
(`inject="api_key"`), never the user's personal key.

## 5. What the user gets

Tools/workflows run in their Galaxy (outputs are history datasets); the analysis
notebook persists as a per-history Galaxy **Page** (slug `orbit-<historyId>`) and
resumes on relaunch. Served at `/`, WebSocket at `/ws`, entry-point port 3000,
subdomain routing via gx-it-proxy.
