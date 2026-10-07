# Akai storefront — Astro SSR on the Node adapter (standalone server).
# Build context is the repo root (the workspace libs are compiled in).
# All configuration is read at runtime; nothing is baked in at build time.

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
COPY libs/rich-text/package.json libs/rich-text/
COPY libs/session/package.json libs/session/
COPY libs/testing/package.json libs/testing/
COPY libs/ui/package.json libs/ui/
RUN pnpm install --frozen-lockfile

FROM node:22.12-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /root/.cache/node/corepack /root/.cache/node/corepack
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm nx run storefront:build

FROM node:22.12-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
RUN addgroup -S akai && adduser -S -G akai akai
# The server bundle still imports npm packages at runtime, so node_modules ships
# alongside dist/.
COPY --from=build --chown=akai:akai /app/node_modules ./node_modules
COPY --from=build --chown=akai:akai /app/apps/storefront/dist ./apps/storefront/dist
USER akai
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/404').then(r=>process.exit(r.status===404?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/storefront/dist/server/entry.mjs"]
