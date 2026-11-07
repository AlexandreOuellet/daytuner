# DayTuner: one container running the web interface, its API and the daily scheduler.
# Build:  docker build -t daytuner .
# Run:    docker run -p 8420:8420 -v daytuner:/config -e TUNARR_URL=http://tunarr:8000 daytuner
# See docs/deploy.md.

# --- build the pages -------------------------------------------------------------------------------------------
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm --filter @daytuner/ui build

# --- the running image: only what the server and the command line need -------------------------------------------
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/cli ./apps/cli
# The workspace lists apps/ui too; give pnpm its manifest, install nothing for it.
COPY apps/ui/package.json ./apps/ui/package.json
RUN pnpm install --frozen-lockfile --prod --filter @daytuner/web... --filter @daytuner/cli... \
 && find packages apps -name '*.test.ts' -o -name '*.test.tsx' | xargs -r rm -f
COPY --from=build /app/apps/ui/dist ./apps/ui/dist

# The command line, for `docker exec daytuner daytuner channel list` and the like.
RUN printf '#!/bin/sh\ncd /app/apps/cli && exec node --import tsx src/main.ts "$@"\n' > /usr/local/bin/daytuner && chmod +x /usr/local/bin/daytuner \
 && mkdir -p /config && chown node:node /config

ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    DAYTUNER_DB=/config/daytuner.db \
    DAYTUNER_HOST=0.0.0.0 \
    DAYTUNER_PORT=8420 \
    DAYTUNER_UI_DIR=/app/apps/ui/dist
# TUNARR_URL is required. DAYTUNER_ALLOW_WRITES=1 lets this container write lineups to Tunarr (off by default).
# There is no login: only expose the port to people who may change your lineups.
VOLUME /config
EXPOSE 8420
USER node
WORKDIR /app/apps/web
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.DAYTUNER_PORT||8420)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]
