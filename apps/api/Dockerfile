# syntax=docker/dockerfile:1
#
# Production image for the Baton API (@baton/api).
#
# Build context MUST be the repository root, not apps/api — the build needs the
# whole pnpm workspace and the shared lockfile:
#
#   docker build -f apps/api/Dockerfile -t baton-api .
#
# Railway/Render/Fly: set the Dockerfile path to apps/api/Dockerfile and the
# build context / root directory to the repository root.

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

# Whole workspace: the API depends on several workspace packages that must be
# built from source. .dockerignore keeps node_modules/dist/.git out of context.
COPY . .

# Install every workspace dependency (a warm pnpm store speeds up rebuilds).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Build @baton/api and every workspace package it depends on (the "..." suffix).
RUN pnpm --filter @baton/api... build

# Produce a self-contained bundle: dist + only production deps, with workspace
# packages injected into node_modules. --legacy is required from pnpm v10 for a
# non-injected workspace. Target must live outside the workspace.
RUN pnpm --filter @baton/api --legacy deploy --prod /app

FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Containers must bind all interfaces; the platform maps the port.
ENV HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app /app

# Default API port; override with PORT. Health check: GET /health/live.
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/main.js"]
