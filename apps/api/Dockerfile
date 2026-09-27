# =============================================================================
# apps/api — production image.
#
# Multi-stage and non-root. Built from the WORKSPACE ROOT, not this directory:
#
#   docker build -f apps/api/Dockerfile -t akai-api .
#
# An Nx integrated monorepo keeps every dependency in the root package.json and
# hoists node_modules to the root, so a build context scoped to apps/api would
# contain no lockfile, no libs/ and nothing to install. That is the single most
# common way this build is invoked wrongly.
# =============================================================================

# --- Stage 1: dependencies ---------------------------------------------------
# Split from the build stage so a source-only change reuses the cached install.
# This is the slowest layer by an order of magnitude.
FROM node:20.19-alpine AS deps
WORKDIR /app

RUN corepack enable

# Only the files that affect dependency resolution. Copying the whole tree here
# would invalidate this layer on every source edit and defeat the split.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY libs/config/package.json libs/config/
COPY libs/contracts/package.json libs/contracts/
COPY libs/db/package.json libs/db/
COPY libs/email-templates/package.json libs/email-templates/
COPY libs/i18n/package.json libs/i18n/
COPY libs/money/package.json libs/money/
COPY libs/observability/package.json libs/observability/
COPY libs/testing/package.json libs/testing/
COPY libs/ui/package.json libs/ui/

# --frozen-lockfile: a lockfile that does not satisfy the manifests fails the
# build rather than silently resolving something new. A production image must
# not be the first place a dependency is chosen.
RUN pnpm install --frozen-lockfile


# --- Stage 2: build ----------------------------------------------------------
FROM node:20.19-alpine AS build
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

# The Prisma client is GENERATED code — it does not exist in the repository.
# Without this the build fails on the first `@prisma/client` import, and at
# runtime a stale client silently disagrees with the schema.
RUN pnpm exec prisma generate --schema libs/db/prisma/schema.prisma

RUN pnpm nx run api:build


# --- Stage 3: runtime --------------------------------------------------------
FROM node:20.19-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Non-root. A container that runs as root turns any RCE into host-adjacent
# access, and nothing this process does needs privilege.
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

# node_modules comes from BUILD, not deps.
#
# `prisma generate` ran in the build stage, and under pnpm its output does NOT
# land in `node_modules/.prisma` — that is the npm/yarn flat layout. pnpm keeps
# packages in an isolated store, so the generated client is written inside
# `node_modules/.pnpm/@prisma+client@<version>_<hash>/node_modules/.prisma`.
# Taking node_modules from deps and then copying `node_modules/.prisma`
# separately therefore fails the build outright ("/app/node_modules/.prisma: not
# found"), and pinning the hashed store path instead would break on every Prisma
# upgrade. Sourcing the whole tree from build is both correct and stable, and
# costs nothing: deps installs the same dependency set.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/api ./dist
COPY --from=build /app/libs/db/prisma ./libs/db/prisma
COPY package.json pnpm-workspace.yaml ./

# NOTE ON THE ENTRYPOINT PATH (below): it is `dist/apps/api/src/main.js`, not
# `dist/main.js`.
#
# `tsc` infers rootDir from the widest common ancestor of every input, and the
# API imports libs/* through path aliases — so the inputs span both apps/api and
# libs, the inferred root is the workspace root, and the emitted tree keeps that
# structure under outDir. The build also runs `tsc-alias`, which rewrites the
# emitted `require("@akai/config")` into a relative path; without that step the
# image builds successfully and then crashes on the first require at runtime,
# because nothing links @akai/* into node_modules.

USER akai

EXPOSE 3333

# Hits the liveness probe the health module exposes. Marked @Public, so it does
# not need a credential — verified rather than assumed, because a health check
# that 401s makes an orchestrator kill a perfectly healthy container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3333/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are deliberately NOT run here. `prisma migrate deploy` from an
# application container means N replicas racing the same migration on rollout,
# and it requires the app's role to own the schema — which would undo the
# privilege split that makes the audit log append-only. Run migrations as a
# separate deploy step, as the owner role. See README "Deployment".
CMD ["node", "dist/apps/api/src/main.js"]
