# syntax=docker/dockerfile:1
#
# Production image for the Baton worker (@baton/worker).
#
# NOTE: as of Phase 1 the worker is a heartbeat-only stub — durable memory jobs
# arrive in Phase 2. You do not need to run it yet. It is Dockerized here so the
# deploy story is complete once real jobs land.
#
# Build context MUST be the repository root:
#
#   docker build -f apps/worker/Dockerfile -t baton-worker .

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY . .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

RUN pnpm --filter @baton/worker... build

RUN pnpm --filter @baton/worker --legacy deploy --prod /app

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app

# No inbound port — the worker is a background process that polls the database.
CMD ["node", "--enable-source-maps", "dist/main.js"]
