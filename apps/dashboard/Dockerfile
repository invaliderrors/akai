# =============================================================================
# apps/dashboard — production image (Next 15 standalone).
#
# Build from the WORKSPACE ROOT:
#   docker build -f apps/dashboard/Dockerfile -t akai-dashboard .
#
# NEXT_PUBLIC_* VARIABLES ARE BAKED IN AT BUILD TIME, not read at runtime. Next
# inlines them into the client bundle during `next build`, so they must be
# passed as --build-arg here; setting them only in the runtime environment
# leaves the browser with `undefined`.
#
# Server-only secrets (SESSION_SECRET, API_INTERNAL_URL) are the opposite: they
# are runtime environment only and must never become build args.
# =============================================================================

FROM node:22.12-alpine AS deps
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/storefront/package.json apps/storefront/
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

# Only the build args the dashboard actually reads. NEXT_PUBLIC_* values are
# inlined into the client bundle at build time, so anything declared here and
# left unread ships a stale constant into the image rather than failing —
# and, the OTHER direction, anything the dashboard reads that is NOT declared
# as an ARG here is silently dropped: Dokploy passes every configured env var
# as a --build-arg regardless of whether this Dockerfile asked for it, and
# Docker discards a build-arg with no matching ARG line with no warning at
# all. That is exactly how NEXT_PUBLIC_SITE_URL shipped as `undefined` into a
# live image after being set correctly in Dokploy's own env config — this
# file simply never declared it.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# SESSION_SECRET is deliberately NOT a build arg. It is read at runtime only,
# and baking a secret into an image layer makes it readable by anyone who can
# pull the image — `docker history` is not a secret store.
#
# `dashboard:build`, NOT `storefront:build`. This file was copied from the
# storefront's Dockerfile and the target came with it, so the image built the
# WRONG APP: the storefront's output went to apps/storefront/.next while every
# COPY below reads from apps/dashboard/.next, and the build died on
# "/app/apps/dashboard/.next/standalone: not found" — a missing-file error that
# names the destination and says nothing about the wrong build target.
RUN pnpm nx run dashboard:build


FROM node:22.12-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0

RUN addgroup -S akai && adduser -S -G akai akai

# The standalone output carries its own minimal node_modules, traced from the
# actual import graph — so no pnpm install happens in this stage and the image
# does not contain the workspace's dev dependencies.
COPY --from=build --chown=akai:akai /app/apps/dashboard/.next/standalone ./
COPY --from=build --chown=akai:akai /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build --chown=akai:akai /app/apps/dashboard/public ./apps/dashboard/public

USER akai

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Path mirrors the workspace layout because outputFileTracingRoot is the
# workspace root — standalone preserves the app's position under it.
CMD ["node", "apps/dashboard/server.js"]
