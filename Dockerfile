# syntax=docker/dockerfile:1.6
FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY app/package.json app/package-lock.json ./app/
COPY web/package.json web/package-lock.json ./web/
RUN npm ci
RUN cd app && npm ci
RUN cd web && npm ci

COPY . .
RUN cd web && npm run build

FROM node:22-slim AS runner

ENV NODE_ENV=production
ENV LOOM_MODE=remote
ENV PORT=3000
# Reachable via the published port. The server refuses to start on this bind
# without LOOM_WEB_TOKEN (or LOOM_WEB_ALLOW_INSECURE=1 behind a trusted proxy),
# so the exposed container is fail-closed rather than an open agent.
ENV LOOM_WEB_HOST=0.0.0.0

WORKDIR /app

# Copy runtime artifacts only
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/extensions ./extensions
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/web/server.ts ./web/server.ts
COPY --from=builder /app/web/auth.ts ./web/auth.ts
COPY --from=builder /app/web/rpc-guard.ts ./web/rpc-guard.ts
COPY --from=builder /app/web/orbit-shim.ts ./web/orbit-shim.ts
COPY --from=builder /app/web/extensions ./web/extensions
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/web/node_modules ./web/node_modules
COPY --from=builder /app/web/package.json ./web/package.json

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
# cache so the runtime `uvx galaxy-mcp>=1.8.0` launch resolves from cache.
RUN uv tool install "galaxy-mcp>=1.8.0"

CMD ["node", "web/node_modules/.bin/tsx", "web/server.ts"]
