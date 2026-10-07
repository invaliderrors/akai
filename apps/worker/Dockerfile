# =============================================================================
# apps/worker — production image.
#
# Build from the WORKSPACE ROOT:
#   docker build -f apps/worker/Dockerfile -t akai-worker .
#
# Same modules as the API, different composition root: this process has no HTTP
# surface beyond a health listener and runs every pg-boss consumer and cron job.
# It is a SEPARATE deployable specifically so a TagadaPay webhook can ACK in under
# a second — the handler enqueues, this process does the slow work.
#
# Scale this independently of the API. They have opposite load profiles: the API
# is latency-sensitive and bursty, the worker is throughput-bound and steady.
# =============================================================================

FROM node:22.12-alpine AS deps
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY libs/config/package.json libs/config/
COPY libs/contracts/package.json libs/contracts/
COPY libs/db/package.json libs/db/
COPY libs/email-templates/package.json libs/email-templates/
COPY libs/money/package.json libs/money/
COPY libs/observability/package.json libs/observability/
COPY libs/testing/package.json libs/testing/
COPY libs/ui/package.json libs/ui/

RUN pnpm install --frozen-lockfile


FROM node:22.12-alpine AS build
WORKDIR /app
RUN corepack enable

# Reuse the pnpm that the deps stage already downloaded.
#
# `corepack enable` only shims the binaries; the pnpm tarball itself is fetched
# on FIRST USE, and each build stage starts with an empty corepack cache. So a
# plain `corepack enable` here re-downloads pnpm from registry.npmjs.org — one
# extra network round trip per stage, and the point where this build actually
# failed (ETIMEDOUT on IPv4, ENETUNREACH on IPv6) even though the deps stage had
# just installed 1700 packages successfully. Copying the cache makes the later
# stages need no network at all.
COPY --from=deps /root/.cache/node/corepack /root/.cache/node/corepack

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm exec prisma generate --schema libs/db/prisma/schema.prisma
RUN pnpm nx run worker:build


FROM node:22.12-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -S akai && adduser -S -G akai akai
RUN corepack enable

# Reuse the pnpm that the deps stage already downloaded.
#
# `corepack enable` only shims the binaries; the pnpm tarball itself is fetched
# on FIRST USE, and each build stage starts with an empty corepack cache. So a
# plain `corepack enable` here re-downloads pnpm from registry.npmjs.org — one
# extra network round trip per stage, and the point where this build actually
# failed (ETIMEDOUT on IPv4, ENETUNREACH on IPv6) even though the deps stage had
# just installed 1700 packages successfully. Copying the cache makes the later
# stages need no network at all.
COPY --from=deps /root/.cache/node/corepack /root/.cache/node/corepack

# node_modules from BUILD, not deps: prisma generate ran there, and under pnpm
# its output lands inside the isolated store
# (node_modules/.pnpm/@prisma+client@<version>_<hash>/node_modules/.prisma), never
# in the npm-style flat node_modules/.prisma. See apps/api/Dockerfile.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/worker ./dist
COPY --from=build /app/libs/db/prisma ./libs/db/prisma
COPY package.json pnpm-workspace.yaml ./

USER akai

EXPOSE 3334

# The worker's only HTTP surface. It exists so an orchestrator can tell a
# consumer that is alive-but-wedged from one that has exited — a queue consumer
# with no health surface looks identical to a healthy idle one from outside.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3334/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Path shape matches the API image — see the note in apps/api/Dockerfile for why
# the emitted tree is nested and why `tsc-alias` is part of the build.
CMD ["node", "dist/apps/worker/src/main.js"]
