# syntax=docker/dockerfile:1
# Hosted Orbit: one image with the host, the conversation worker and the page. Build from the
# repository root, since the worker bundles Orbit's brain from extensions/ and shared/:
#
#   docker build -f browser/hosted/Dockerfile -t orbit-hosted .
#
# Every setting comes from the environment; see .env.example.

FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY . .
# The root package is the desktop app; its install scripts (husky, Electron) aren't needed to bundle.
RUN npm ci --ignore-scripts \
 && cd browser && npm ci --ignore-scripts \
 && npm run build:skills -w @galaxyproject/orbit-browser \
 && cd hosted && npm run build

FROM node:24-bookworm-slim
WORKDIR /app
# Everything is bundled: the host and worker need no node_modules at run time.
COPY --from=build --chown=node:node /src/browser/hosted/dist/ /app/
USER node
ENV NODE_ENV=production \
    ORBIT_COMPILE_CACHE=/tmp/orbit-compile-cache
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.ORBIT_PORT || 7878) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "host.mjs"]
