# Akai

**赤い — Japanese-style streetwear.** An Nx monorepo holding the whole shop:

| App | Stack | Port (dev) | What it does |
| --- | --- | --- | --- |
| `apps/storefront` | Astro 7 (SSR) + React islands + Tailwind v4 | 3100 | The shop: catalogue, product pages, cart, checkout |
| `apps/dashboard` | Next.js 15 | 3101 | Customer accounts (sign-in, orders, addresses) and staff admin |
| `apps/api` | NestJS 11 + Prisma + PostgreSQL | 3333 | Source of truth: catalogue, carts, orders, payments (Whop), shipping zones/rates, email |
| `apps/worker` | NestJS | — | Empty shell (the outbox runs in the API process) |

Akai sells in **Colombia only**: prices in COP (IVA 19% included), Colombian
addresses (departamento + ciudad), the buyer's identity document at checkout, and
manual shipping (staff record the carrier and tracking number).

Shared code lives in `libs/*` (`contracts`, `db`, `money`, `config`, `i18n`, `session`,
`rich-text`, …). Spanish is the default locale at `/`, English is at `/en`.

See **`CLAUDE.md`** for architecture rules and **`TASKS.md`** for the roadmap.

## Getting started

Requirements: Node ≥ 22.12, pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install
cp .env.example .env              # placeholders work for local development
docker compose up -d postgres minio minio-provision mailpit
pnpm db:deploy                    # apply migrations
pnpm db:seed                      # streetwear placeholder catalogue + dev accounts

pnpm dev:api                      # http://localhost:3333  (Swagger at /docs)
pnpm dev:dashboard                # http://localhost:3101
pnpm dev                          # http://localhost:3100  (storefront)
```

Or run everything in containers: `docker compose up -d --build`.

Seeded accounts: `admin@akai.test` / `dev-admin-password-change-me` (must enrol TOTP
before `/admin`), `customer@akai.test` / `dev-customer-password-change-me`.
Outgoing mail lands in Mailpit at http://localhost:8025.

With `PAYMENTS_ENABLED=false` checkout settles orders locally instead of redirecting
to Whop — handy for development, never for a deployment.

## Scripts

| Command | |
| --- | --- |
| `pnpm build` / `typecheck` / `test` / `lint` / `e2e` | Run the target across every project |
| `pnpm affected` | typecheck, lint, test, build on affected projects |
| `pnpm check:no-any` | Type-safety gate (no `any`, `@ts-ignore`, non-null assertions) |
| `pnpm db:migrate` / `db:deploy` / `db:seed` / `db:studio` / `db:reset` | Database |
| `pnpm nx run <project>:<target>` | One project, e.g. `pnpm nx run storefront:test` |

## Configuration

Everything is in `.env.example`, grouped per app and commented. Storefront settings
are read at **runtime** (`API_INTERNAL_URL`, `PUBLIC_API_URL`, `PUBLIC_DASHBOARD_URL`,
`SESSION_SECRET`, `SESSION_COOKIE_NAME`, `REVALIDATE_SIGNING_SECRET`), so one image
serves every environment.

In production the storefront and dashboard share one sign-in: give both the same
`SESSION_SECRET` and set `SESSION_COOKIE_DOMAIN` on the dashboard to a parent domain
spanning both hosts (e.g. `.akai.shop`). The domain `akai.shop` in the templates is a
placeholder.

## Deployment notes

- Each app has a Dockerfile (build context: repo root).
- The database needs the `akai_app` runtime role (see `tools/postgres/init`) before
  `prisma migrate deploy`, so the invariants migration can apply its grants.
- Pin `WHOP_ENVIRONMENT` explicitly (`sandbox` | `live`).
- Add the storefront and dashboard origins to the API's `CORS_ALLOWED_ORIGINS`.
