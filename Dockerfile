# syntax=docker/dockerfile:1.6
FROM node:22-slim AS builder

WORKDIR /app

# Root deps before any source, so an edit doesn't bust the install layer. These
# are needed at BUILD time, not just runtime: the web bundle is built from the
# Orbit renderer (vite.config.ts roots at app/src/renderer), whose bare imports
# -- marked, dompurify -- are declared in the ROOT package.json. Node resolves
# them by walking up from app/src/renderer/ to /app/node_modules, which never
# reaches web/node_modules, so without this the vite build can't resolve them.
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci

COPY CHANGELOG.md README.md ./
COPY bin ./bin
COPY extensions ./extensions
COPY shared ./shared
COPY app ./app
COPY web ./web
# Bundle the server rather than compiling file-by-file. tsc would emit flat into
# web/build/, keeping `../shared/brain-env.js` in the output -- which resolves to
# web/shared/ at runtime, not the /app/shared this image ships, so the server
# died on module load. Bundling inlines every relative import (shared/, auth,
# rpc-guard, llm-credentials) and leaves bare package imports external for the
# runner's npm ci to supply. Typechecking stays in CI, which has the app deps
# this stage doesn't install.
RUN cd web && npm run build && npm run build:server
RUN cd web && npm prune --production --no-optional

FROM node:22-slim AS runner

ENV NODE_ENV=production
ENV LOOM_MODE=remote
ENV PORT=3000
# Reachable via the published port. The server refuses to start on this bind
# without LOOM_WEB_TOKEN (or LOOM_WEB_ALLOW_INSECURE=1 behind a trusted proxy),
# so the exposed container is fail-closed rather than an open agent.
ENV LOOM_WEB_HOST=0.0.0.0

WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/extensions ./extensions
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/web/build ./web/build
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/web/package.json ./web/package.json
COPY --from=builder /app/web/package-lock.json ./web/package-lock.json
COPY --from=builder /app/web/extensions ./web/extensions

# Drop the root `prepare` script before installing: it runs husky (a devDep) on
# every npm ci, including this --omit=dev one, so npm would exec a binary it was
# just told not to install and die with "husky: not found". The git hooks it
# sets up are meaningless in an image with no .git anyway.
RUN npm pkg delete scripts.prepare \
 && npm ci --production --omit=dev --no-optional \
 && cd web && npm ci --production --omit=dev --no-optional

# Galaxy's tool/workflow execution surface runs through `uvx galaxy-mcp` (a
# Python MCP server). node:slim ships no Python or uv, so bring uv -- which
# manages its own CPython -- from Astral's published image and pre-warm the
# galaxy-mcp tool plus a compatible interpreter into a shared, node-owned cache.
# Baking them in means the GxIT's Galaxy tools work even when PyPI is slow or
# unreachable at job-launch, and turns the build itself into a check that the
# MCP server resolves in this image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.21 /uv /uvx /usr/local/bin/

ENV UV_CACHE_DIR=/opt/uv/cache \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/opt/uv/bin
ENV PATH="/opt/uv/bin:${PATH}"

RUN mkdir -p /opt/uv && chown -R node:node /opt/uv

EXPOSE 3000

# Drop root: the agent process holds live Galaxy/LLM credentials, so don't run
# it as uid 0. The node:slim image ships an unprivileged `node` user.
USER node

# Pre-warm galaxy-mcp (and the managed Python it needs) into the node-owned uv
# cache so the runtime `uvx` launch resolves from cache instead of PyPI.
#
# This MUST stay the spec bin/loom.js writes into mcp.json (GALAXY_MCP_SPEC in
# shared/galaxy-mcp-spec.js) -- pre-warming a version the runtime spec doesn't
# accept sends uv back to the network at job-launch, which is exactly what
# baking the cache is meant to avoid. tests/galaxy-mcp-spec.test.ts fails if
# these two drift apart, so it's a literal rather than a build arg: an ARG would
# let --build-arg put a non-matching spec in the cache while the test still
# passed against its default, which is the bypass the test exists to prevent.
RUN uv tool install "galaxy-mcp>=1.9.0"

CMD ["node", "web/build/server.js"]
