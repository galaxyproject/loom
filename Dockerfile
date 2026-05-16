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

WORKDIR /app

# Copy runtime artifacts only
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/extensions ./extensions
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/web/server.ts ./web/server.ts
COPY --from=builder /app/web/orbit-shim.ts ./web/orbit-shim.ts
COPY --from=builder /app/web/extensions ./web/extensions
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/web/node_modules ./web/node_modules
COPY --from=builder /app/web/package.json ./web/package.json

EXPOSE 3000

CMD ["node", "web/node_modules/.bin/tsx", "web/server.ts"]
