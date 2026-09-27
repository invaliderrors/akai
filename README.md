# Akai

Nx monorepo for a bilingual (Spanish default / English) sports-supplements
e-commerce platform.

A NestJS API + PostgreSQL + Whop is the source of truth for products,
customers, carts, orders, payments and email.

**WordPress and WooCommerce are gone.** The storefront renders entirely off this
workspace's own API — no `wp-json`, no CoCart, no mu-plugin, and no WP environment
variable anywhere in the repo. If you are carrying an `.env` from before the cutover,
delete `NEXT_PUBLIC_WP_URL`, `WP_IMAGE_HOST` and `REVALIDATE_SECRET`; nothing reads
them, and the storefront's media host is now `NEXT_PUBLIC_MEDIA_URL`.

- Conventions and architecture rules: `CLAUDE.md`
- `docs/superpowers/**` is **historical only by default** — it describes the superseded
  Woo-backed design. The one exception is
  `docs/superpowers/specs/2026-09-09-whop-integration-contract.md`, the Whop design
  lock, which is **binding**. See the note at the top of `CLAUDE.md`. (Its predecessor,
  `2026-07-21-tagadapay-integration-contract.md`, is SUPERSEDED and now historical like
  the rest of that tree — it is kept because most of the Whop design is the inverse of
  one of its constraints, and the reasoning is worth being able to read.)

## Workspace

| Project | Status | Purpose |
|---|---|---|
| `apps/storefront` | **live** | Next 15 public storefront, served by `apps/api` |
| `apps/dashboard` | shell | Customer + admin dashboard |
| `apps/api` | shell | NestJS 11 HTTP API |
| `apps/worker` | shell | pg-boss consumers + cron |
| `libs/*` | shells | contracts, db, money, config, i18n, ui, email-templates, testing, observability |

## Storefront architecture (current)

Everything below goes through the typed client in `apps/storefront/src/lib/api/`,
which parses every response against a `@akai/contracts` zod schema. No page
declares a response shape of its own.

- **Products** — `GET /v1/products` and `/v1/products/:slug`, ISR (60s revalidate plus
  on-demand revalidation signed by the API). Parsed against `publicProductSchema`, the
  projection that omits `onHand` / `reserved` / `lowStockThreshold`: the wide shape is
  rejected rather than shipped into a browser bundle. Prices are public, are integer
  **minor units**, and are formatted only through `@akai/money`. The catalog index is
  cursor-paginated with a "load more" control rather than silently truncating at 100.
- **Copy is per-locale in the payload** — `translations[]`, `media[].alt`,
  `category.name` and `variant.name` are locale-keyed records. Resolution lives in one
  place, `apps/storefront/src/lib/catalog/view.ts`; never inline a fallback chain.
- **i18n** — next-intl. Spanish at `/` (no prefix), English at `/en`. UI strings live in `apps/storefront/messages/{es,en}.json`. Components import `Link`/`useRouter`/`usePathname` from `@/i18n/navigation`.
- **The sellable unit is the VARIANT.** The PDP renders a variant picker and the cart
  takes a variant UUID; there is no product-level "add".
- **Cart** — our own `/v1/cart`. The session is an opaque token in the
  `akai_cart_token` cookie, sent as the `x-cart-token` header. The browser talks to the
  API directly (the API lists that header in CORS `exposedHeaders`), so the cookie
  cannot be HttpOnly — an acknowledged XSS exposure, documented and scoped in
  `lib/api/cart-token.ts`. The cart page renders `cart.problems` and BLOCKS checkout on
  every code except `PRICE_CHANGED`.
- **Checkout** — `/checkout` collects email, address, VAT number and a shipping method
  priced by `POST /v1/shipping/quote`, then `POST /v1/checkout` returns a hosted
  Whop URL. The request carries **no amount**; the total is recomputed
  server-side and is what Whop charges. The return screen polls order status — an order becomes `PAID` only via
  a verified webhook — and clears the cart token once it does.
- **Contact** — posts straight to `POST /v1/contact`. Deliberately NOT proxied through a
  Next route handler: the API derives its throttle key from the socket address and does
  not trust `X-Forwarded-For`, so a proxy would collapse the per-IP limit into one
  site-wide bucket.
- **SEO** — `sitemap.ts`, `robots.ts`, hreflang alternates, Open Graph images and
  product JSON-LD are all served by the storefront itself.
- **Accounts** — `apps/dashboard`, linked from the header and footer only when
  `NEXT_PUBLIC_ACCOUNT_URL` is set. Unset hides the links rather than guessing a host.

## Local development

**pnpm only — never `npm install`.**

```bash
pnpm install
cp .env.example .env          # workspace root: API, worker, Prisma, Whop
pnpm docker:up                # Postgres + Mailpit + MinIO
pnpm db:deploy                # apply migrations
pnpm db:seed                  # sample catalog + admin/customer accounts
pnpm start:all                # every app at once (api, worker, storefront, dashboard)
```

Or one at a time:

```bash
pnpm start:api                # http://localhost:3333
pnpm dev                      # storefront  → http://localhost:3100
pnpm dev:dashboard            # dashboard   → http://localhost:3101
pnpm start:worker             # headless, no port
```

Every app exposes a `serve` target meaning "run this app", which is what
`start:all` fans out over.

**The worker starts, initialises, and exits immediately.** It has no consumers
and no listener to hold the event loop open — the pg-boss consumers and the
`/health` listener are a later pass. That is the shell state, not a crash.

Verify the stack is actually up:

```bash
curl localhost:3333/health/ready   # {"status":"ok","checks":{"database":{"status":"up"}}}
```

Health probes are excluded from the `v1` prefix on purpose, so orchestrator
config does not change when the API version does. Everything else is under
`/v1`, and the OpenAPI browser is at `/docs`.

### Ports

Defaults are deliberately shifted, because a developer machine commonly already
runs a native PostgreSQL on 5432 and another project on 3000/3001/9000.

| Service | URL | Note |
| --- | --- | --- |
| API | 3333 | `/docs` for OpenAPI |
| Storefront | 3100 | needs the API on 3333 |
| Dashboard | 3101 | `/en` redirects to sign-in when anonymous |
| Postgres | **5434** → 5432 | host port shifted |
| Mailpit | 8025 | every local email lands here, never a real inbox |
| MinIO | **9002** → 9000 | console on 9003 |

If Prisma reports `P1000 Authentication failed for user akai` against a
container that is demonstrably healthy, a native PostgreSQL owns 5432 and is
answering instead. That is why the host port is 5434.

### Env files

Two levels, and the split is load-bearing:

- **`.env` at the workspace root** — API, worker and Prisma. Nx injects it into
  every task.
- **`apps/*/.env.local`** — the Next apps. Next resolves env from the app root.

Do not duplicate an app variable into the root file. Nx injects the root `.env`
into Vitest too, so a value there silently overrides test fixtures — setting
`NODE_ENV` or `NEXT_PUBLIC_MEDIA_URL` at the root makes the storefront's
product-card tests fail with a `next/image` "hostname not configured" error that
looks like a `next.config` bug and is not.

### Running without a Whop account

The API normally proves its credentials at boot (one `accounts.me()` call) and
refuses to start if they are wrong. To develop without an account, set
`WHOP_BOOT_CHECK=false` in `.env`. The config schema **refuses that value when
`NODE_ENV=production`**, so it cannot reach a deployment.

With the check off, only `startCheckout` and `refundOrder` need the provider —
the catalogue, cart, orders and emails are entirely independent of it. For a full
shop with no account at all, use `PAYMENTS_ENABLED=false`, which settles orders
locally through the same code path a webhook would.

### Testing the webhook locally

The settlement path is fully exercisable with no Whop account, because
verification only needs `WHOP_WEBHOOK_SECRET`. Whop uses **Standard Webhooks**:
the signature covers `{webhook-id}.{webhook-timestamp}.{body}`, and the secret is
base64-encoded before use as the HMAC key (the `ws_` prefix is part of it — do
not strip it).

```bash
SECRET=$(grep '^WHOP_WEBHOOK_SECRET=' .env | cut -d= -f2)
ID="msg_local_1"
TS=$(date +%s)
BODY='{"id":"evt_1","type":"payment.succeeded","data":{"id":"pay_1","total":10.00,"currency":"eur","metadata":{"order_id":"00000000-0000-4000-8000-000000000000"}}}'
SIG=$(node -e "
  const [secret, id, ts, body] = process.argv.slice(1);
  const key = Buffer.from(Buffer.from(secret).toString('base64'), 'base64');
  console.log(require('crypto').createHmac('sha256', key).update(\`\${id}.\${ts}.\${body}\`).digest('base64'));
" "$SECRET" "$ID" "$TS" "$BODY")

curl -X POST localhost:3333/v1/webhooks/whop \
  -H "content-type: application/json" \
  -H "webhook-id: $ID" -H "webhook-timestamp: $TS" -H "webhook-signature: v1,$SIG" \
  -d "$BODY"
```

Note `total` is in **major units** (10.00, not 1000) — that is Whop's webhook
plane, and it is the opposite of our integer-minor ledger.

An unsigned, forged or more-than-five-minutes-old request is rejected with `400`
— the timestamp is inside the signed material, so a captured delivery cannot be
replayed by re-stamping the header. A valid one returns
`{"received":true,"outcome":"unmatched"}` when no order matches. For the full
dedupe and amount-mismatch behaviour against a real database, run
`pnpm nx run api-e2e:e2e` (testcontainers; Docker must be running).

### Stop the dev servers before `pnpm build`

The Next dev servers hold locks on their `.next` directories, and a build that
runs alongside them fails while the same build succeeds once they are stopped.
The error surfaces as a build-tool failure rather than "something else is using
this directory", so it is easy to misread as a broken build.

### Seeded accounts

```
admin@akai.test    / dev-admin-password-change-me
customer@akai.test / dev-customer-password-change-me
```

The admin has no TOTP enrolled, and `/admin/*` refuses it until enrolment is
completed through the dashboard. That is the 2FA requirement working, not a
broken seed.

### Seeded product media needs MinIO

`pnpm db:seed` UPLOADS its fixture images (`apps/api/src/seed/assets/`) to the
object store and then records `${S3_ENDPOINT}/${S3_BUCKET}/seed/products/…` —
the same URL shape `POST /v1/admin/media/upload-url` produces, and the same one
`NEXT_PUBLIC_MEDIA_URL` tells `next/image` to allow. So `pnpm docker:up` must
have run first; a seed that cannot reach the bucket fails loudly rather than
writing rows that point at nothing.

It used to point them at `http://localhost:3100/carousel/…` — the storefront
serving its own `public/` directory. That made the API's catalogue depend on the
frontend being up on one specific port: run the storefront anywhere else (the
Playwright dev server binds 3002) and every image request was refused, silently,
because `remotePatterns` matches on hostname and never sees the port.

## Scripts

All scripts delegate to Nx and run across every project.

| Command | Purpose |
|---|---|
| `pnpm dev` | Storefront dev server (`pnpm dev:dashboard` for the dashboard) |
| `pnpm test` | Unit/integration tests (Vitest) |
| `pnpm typecheck` | TypeScript check |
| `pnpm lint` | ESLint (incl. the `next/link` guard and Nx module boundaries) |
| `pnpm e2e` | Playwright E2E (starts the dev server; needs the API and its database up) |
| `pnpm build` | Production builds (the storefront pages the whole catalog for `generateStaticParams` and `sitemap.ts`, so the API must be reachable) |
| `pnpm affected` | typecheck + lint + test + build, scoped to affected projects |

Single project: `pnpm nx run storefront:test`. Bypass the cache with `--skip-nx-cache`.

### Standing up Whop in a new environment

The API will not boot without `WHOP_WEBHOOK_SECRET`, and that value exists nowhere
until the endpoint is registered. **There is no repo script for this** — unlike the
previous provider, Whop has no endpoint-creation API worth automating, so it is a
dashboard action:

1. Whop dashboard → **Developer → API keys**: create a server key → `WHOP_API_KEY`.
2. Note the account id (`biz_…`) → `WHOP_ACCOUNT_ID`.
3. Create ONE product to hang per-order plans off (e.g. "Akai Order") →
   `WHOP_PRODUCT_ID`. Nothing we sell is represented there: Whop takes the amount
   on the checkout call, so a plan simply has to belong to a product.
4. **Developer → Webhooks**: add `https://<host>/v1/webhooks/whop`, subscribe to
   `payment.succeeded`, `payment.failed`, `refund.created`, `refund.updated`, and
   copy the signing secret → `WHOP_WEBHOOK_SECRET` (keep the `ws_` prefix).
5. Pin `WHOP_API_VERSION_DATE`. It is required rather than defaulted: Whop
   versions payload shapes by date, including the webhook body the settlement
   check reads.

The secret goes straight into that environment's secret store, never through the
logger, which redacts it by path. Two endpoints on one URL deliver every event
twice under two different secrets, and only one of them verifies.
**Each environment needs its own secret**: sharing staging's with
production means a delivery captured at staging replays against production, because the
CRM HMAC covers the raw body alone with no timestamp bound into it.

## Environment variables

`.env.example` at the workspace root enumerates every key across all apps with
placeholder values. The storefront reads its own `apps/storefront/.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:3333    # platform API, as the BROWSER reaches it
API_INTERNAL_URL=http://localhost:3333       # same API from inside our network (optional)
NEXT_PUBLIC_SITE_URL=http://localhost:3100   # this storefront's own public origin
NEXT_PUBLIC_MEDIA_URL=http://localhost:9002  # media origin for next/image remotePatterns
REVALIDATE_SIGNING_SECRET=...                # MUST match the API's value
# NEXT_PUBLIC_ACCOUNT_URL=http://localhost:3101      # optional; unset hides account links
# NEXT_PUBLIC_AFFILIATE_SIGNUP_URL=https://…         # optional; unset routes to /contact
```

`NEXT_PUBLIC_API_URL` is public by necessity, not by accident: the browser talks to the
API directly for the cart (`x-cart-token`), the contact form, the shipping quote, and
the post-checkout processing screen (`/checkout/processing?order=…`, the Whop
redirect URL), which polls `GET /v1/payments/orders/:number/status` until the payment
settles. An order becomes `PAID` only via a verified webhook, so that page asks the API
instead of trusting the redirect it arrived on.

`API_INTERNAL_URL` wins on the server and is invisible in the browser, so a server
render does not round-trip out to the public edge and back. It falls back to
`NEXT_PUBLIC_API_URL`.

`REVALIDATE_SIGNING_SECRET` is the name `libs/config` validates and
`apps/api/src/modules/revalidation` signs with. The retired `REVALIDATE_SECRET` was a
second name for the same thing and is no longer read — `/api/revalidate` returns 503 if
only the old name is set.

`NEXT_PUBLIC_MEDIA_URL` feeds `images.remotePatterns`, and the protocol is read FROM the
URL. Getting it wrong is not a broken-image icon: next/image answers 400 from the
optimiser.

## Deploy (Vercel)

1. Import the repo; set the env vars above.
2. Add the production storefront origin to the API's `CORS_ALLOWED_ORIGINS`. The browser
   calls `/v1/cart`, `/v1/contact` and `/v1/shipping/quote` directly, and the cart
   depends on `x-cart-token` appearing in both `allowedHeaders` and `exposedHeaders`.
3. Point `NEXT_PUBLIC_SITE_URL` at the real domain and `NEXT_PUBLIC_MEDIA_URL` at the
   CDN in front of the media bucket — the sitemap, canonical tags, Open Graph images and
   JSON-LD all publish absolute URLs built from the first, and next/image rejects any
   host missing from the second.

## Hardening follow-ups (before high-traffic launch)

- **Sanitize product copy if it ever becomes HTML** — the PDP renders
  `translations[].description` as PLAIN TEXT today. The moment the admin gains a
  rich-text editor, add a sanitizer; do not reach for an unguarded
  `dangerouslySetInnerHTML`.
- **Nonce-based CSP** — `apps/storefront/next.config.ts` ships baseline security headers
  but no CSP; Next's inline hydration scripts need per-request nonce middleware.

## Testing notes

- Unit/integration: Vitest + Testing Library (`apps/storefront/src/**/*.test.{ts,tsx}`).
- E2E: Playwright (`apps/storefront-e2e/`). The add-to-cart → cart → checkout path runs
  against the real API and no longer skips itself. `locale-smoke.spec.ts` is a migration
  guard — do not delete it (see `CLAUDE.md`).
- `beforeEach(() => someMock.mockReset())` **without braces** returns the mock, and
  Vitest treats a function returned from a hook as a teardown callback — so the mock is
  called once more after every test with nobody awaiting it. On a rejecting mock that
  surfaces as a spurious unhandled rejection blamed on the test that just passed. Brace
  the body.
