# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Project

**Akai (赤い, "red")** — a Japanese-style streetwear shop that sells in **Colombia
only**. An Nx monorepo: a NestJS API + PostgreSQL is the source of truth for
products, customers, carts, orders, payments (Wompi Web Checkout) and shipping
zones/rates; a Next.js dashboard serves customers and staff; an
Astro storefront sells. **Spanish only (es-CO)**: there is no English, no locale
routing and no per-language content anywhere — see "Language" below.

The API, dashboard and libs were forked from an earlier shop (a supplements store)
and generalised. Its supplement-only domain (lots/batches, certificates of analysis,
product "form", research-use copy) is **deliberately gone** — do not restore it from
an older project. `TASKS.md` tracks what is left to build.

`docs/specs/` holds one **binding** spec carried over with the platform:

- `wompi-integration.md` — the Wompi payments design lock. Where it disagrees with the
  code, it wins and the code is the defect; a deliberate deviation amends the contract
  in the same commit.

## Colombia — the market rules

- **Currency is COP**, stored as integer MINOR units = **centavos** (×100):
  $ 89.000 is `8_900_000` — exactly Wompi's `amount_in_cents`. COP is DISPLAYED and
  ENTERED in whole pesos (`displayFractionDigits` in `@akai/money`, always `es-CO`):
  "$ 89.000", and the dashboard's money input reads "89000" / "89.000".
  `MINOR_MAX` is therefore $ 20.000.000 per amount.
- **IVA**: prices are IVA-inclusive; `tax_rate` holds CO STANDARD 19% (REDUCED 5%).
  The net/tax/gross split is unchanged. There is no EU VAT-number / reverse charge.
- **Destinations** are `["CO"]` (`DESTINATION_COUNTRY_CODES`). Seed: one "Colombia"
  zone, one flat "Envío nacional" rate ($ 15.000), free from $ 300.000
  (`FREE_SHIPPING_THRESHOLD_MINOR` = `ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR`).
- **Addresses** (`addressFieldsSchema`): `region` is the REQUIRED departamento,
  normalised to a name from `COLOMBIAN_DEPARTAMENTOS` (33 entries, DANE code + Spanish
  name); `city` is the municipio; the number goes in `line1` ("Calle 10 # 43-21");
  `postalCode` is optional (six digits); `phone` is a Colombian mobile normalised to
  10 digits without +57 — required at checkout. There is no house-number field.
- **Identity document**: checkout requires `documentType` (CC, CE, NIT, PP, TI, PPT)
  and `documentNumber`, normalised per type by `normaliseDocumentNumber` (NIT check
  digit verified) and snapshotted on the order (`order.documentType/documentNumber`).
  The Wompi checkout pre-fills `customer-data:legal-id(-type)` from it (PPT → OTHER).
- **Shipping is manual**: staff record a parcel on the order page (carrier and tracking
  number as free text — `POST /admin/orders/:n/shipments`) and mark it delivered.
  Shipment statuses are PENDING, IN_TRANSIT, DELIVERED, RETURNED, LOST. There is no
  carrier integration.

## Language — Spanish only

- **One language, one field.** Product copy (`name`, `shortDescription`, `description`)
  and blog copy (`title`, `excerpt`, `bodyHtml`, meta, `coverAlt`) are columns on
  `product` / `blog_post`; `category.name`, `product_variant.name`, `media_asset.alt`
  and `shipping_rate.name` are plain strings. There is no `Locale` enum, no `locale`
  column or request parameter, and no translation table — do not reintroduce one
  "for later": adding a language is a deliberate data-model change.
- **Formatting** goes through `STORE_LOCALE` (`es-CO`) and `STORE_TIME_ZONE`
  (`America/Bogota`) from `@akai/contracts`: money via `@akai/money`, dates via
  `Intl.DateTimeFormat(STORE_LOCALE, { …, timeZone: STORE_TIME_ZONE })`. A fixed zone
  also keeps a server-rendered date identical to its hydrated twin.
- **No `/en`.** Every page lives at its bare path. The storefront middleware 301s old
  `/en/*` (and `/es/*`) links to it.
- **User-facing copy is Spanish and lives in one catalogue per app** (storefront
  `src/i18n/messages.ts`, dashboard `messages/es.json`); the API's error `message`
  strings stay English — they are for logs and never rendered.

## Workspace layout

```
apps/
  storefront/       Astro 7 SSR storefront (Node adapter, React islands, Tailwind v4).
  api/              NestJS 11 HTTP API (Express adapter).
  api-e2e/          Integration suites: supertest + real Postgres via testcontainers.
  dashboard/        Next 15 customer + admin dashboard (auth, account, admin).
  dashboard-e2e/    Playwright specs for the dashboard.
  worker/           Headless Nest process. SHELL — EMPTY (see below).
libs/
  contracts/        zod schemas — the shared vocabulary. Depends on NOTHING but zod.
  db/               Prisma client, schema, migrations, ownership-scoped repos. SERVER ONLY.
  money/            The ONLY money implementation.
  config/           Zod-validated, fail-fast typed env config (API/worker).
  session/          The ONE sealed-session implementation (AES-256-GCM via Web Crypto),
                    the session payload contract and CSRF primitives.
  rich-text/        The ONE answer to "what HTML is allowed?" (`sanitizeRichText`).
  ui/               Shared React components (dashboard).
  email-templates/  SHELL — the live templates sit in apps/api/src/modules/email.
  testing/          Test fakes and builders.
  observability/    Logging, tracing, request-id propagation.
docs/specs/         The binding Wompi spec above.
```

## Commands

**pnpm only. Never `npm install`** — one lockfile, one dependency graph. Node ≥ 22.12
(Astro 7's floor). All dependencies are declared in the ROOT `package.json`; app
`package.json` files are name-only.

```bash
pnpm install
pnpm dev                  # storefront → http://localhost:3100
pnpm dev:dashboard        # dashboard  → http://localhost:3101
pnpm dev:api              # api        → http://localhost:3333
pnpm build | typecheck | test | lint | e2e      # nx run-many
pnpm affected             # typecheck,lint,test,build on affected projects
pnpm check:no-any         # CI type-safety gate (server + libs)

pnpm db:migrate | db:deploy | db:seed | db:studio | db:reset

pnpm nx run storefront:test                    # one project
pnpm nx run storefront:build --skip-nx-cache   # bypass the Nx cache
```

Env: copy `.env.example` to `.env` (Nx loads it for every task). `docker compose up -d`
runs Postgres, MinIO, Mailpit and every app.

## Non-negotiable engineering rules

1. **Zero `any`.** No `as any`, no `@ts-ignore`, no `@ts-expect-error` to silence a real
   error, no non-null assertion used to dodge a type error. `unknown` + narrowing for
   external data; a typed adapter around loose library types. ESLint's type-aware
   `no-unsafe-*` rules and `check:no-any` enforce it.
2. **Validate every external input at the boundary** with zod (`.strict()` request
   schemas). A static type must be earned at runtime, not asserted.
3. **Money is INTEGER minor units end to end.** Never floats, never `Decimal`. Format
   only through `@akai/money` (`formatMoney(amount, currency)` — always es-CO).
4. **No secrets in code.** API/worker config flows through `libs/config`, which fails
   fast on boot; the web apps validate their own env with zod at first use.
5. **Every module ships tests.** Failing test → minimal implementation → pass → commit.
6. **Never fabricate passing results.** Run the command; report the real output.

## Architecture facts that span files

**Module boundaries are mechanically enforced** by `@nx/enforce-module-boundaries`.
Tags live in each `project.json`:

- `scope:web` (storefront, dashboard) → may depend on `scope:shared` only.
- `scope:server` (api, worker) → `scope:shared` + `scope:server`.
- `libs/db` is `scope:server`, so a web app importing it is a lint error — the only
  thing keeping Prisma out of a browser bundle.
- `libs/contracts` is `type:contract` and may depend on nothing.

**`@/*` is app-local**, mapped in each app's own tsconfig to its `./src`. `paths` is a
shallow override, so cross-project `@akai/*` aliases are repeated in each app config.
`tsconfig.base.json` has no `include`. `apps/api/tsconfig.app.json` pins
`useDefineForClassFields: false` — `ES2022` flips it on and silently destroys decorator
metadata (opaque runtime DI failures, not compile errors).

**The store and the dashboard share ONE session.** Same cookie name
(`SESSION_COOKIE_NAME`, default `akai_session`), same `SESSION_SECRET`. The dashboard
signs people in and writes the cookie; the storefront only reads it (header "account"
link). In development both are `localhost` ports, and cookies ignore ports. In production
they are different hosts, so `SESSION_COOKIE_DOMAIN` must be a parent spanning both, in
the dashboard — unset, the cookie is host-only and the storefront never sees it. Never
widen it to a domain that also hosts third-party or user-controlled content.

**The browser talks to the API directly** for cart, shipping quotes, checkout and the
payment-status poll. The cart is identified by an `x-cart-token` header the API mints
and lists in CORS `exposedHeaders`. The API's throttle guard keys on the socket address
and does NOT trust `X-Forwarded-For`, so proxying those calls through a web server would
put every shopper in one rate-limit bucket. A web-app route handler is justified only
when it handles TOKEN MATERIAL (the dashboard's auth routes).

**The outbox runs inside the API process.** `main.ts` starts `OutboxRunner` after
`listen()` and the cron sweeps, polling with `FOR UPDATE SKIP LOCKED`. There is no
pg-boss. `apps/worker` is an empty shell and may not import `apps/api` (module
boundaries); implementing it means moving handlers deliberately, not duplicating them.
Registered consumers: `email`, `storefront.revalidate`. Topics without a shipped
module dead-letter visibly at `/admin/jobs` by design.

**Order numbers** are `AK-YYYY-NNNNNN`, generated in the database
(`next_order_number()` in the `invariants` migration).

**Migrations** start fresh: `20260927000000_init` (Prisma-generated DDL) and
`20260927000100_invariants` (everything Prisma cannot express: partial unique indexes
for soft-deleted rows, CHECK constraints, composite FKs, sequences/functions,
append-only triggers, `akai_app` grants). Schema comments that say a constraint is a
"PARTIAL index" mean it lives there — declaring `@unique` would recreate the
unconditional index and break soft-delete. `tools/postgres/init` provisions the
`akai_app` runtime role locally; production must do the same by hand.

## What is left to implement (API)

- **Empty `@Module({})` placeholders** registered in `AppModule`: `audit`, `disputes`,
  `gdpr`, `invoices`, `metrics`, `notifications`, `pricing`. `audit` has a waiting job:
  several `ProductsService` mutations lost their `actorId` and take it back when it ships.
- **Shipping** is zones + rates (staff-editable in `/admin/shipping`) and a manual
  shipment flow. Sendcloud was removed deliberately (EU carriers); do not restore it.
- Overselling is guarded: checkout reserves every line through
  `ProductInventoryService.reserve` (atomic guarded UPDATE with a TTL).

## Payments — Wompi

Checkout creates the order and redirects to **Wompi Web Checkout**
(`checkout.wompi.co/p/`). No Stripe, no card data on our side. Contract:
`docs/specs/wompi-integration.md`.

- **Our API is the source of truth.** The checkout URL carries our computed
  `grandTotal` as `amount-in-cents` (centavos on both sides — no conversion) and a
  `signature:integrity` = sha256(reference + amount + currency + expiration + integrity
  secret), built server-side. There is no catalogue mirror — do not build one.
- **Reference = `<orderNumber>-<attempt>`**, minted under the order row lock and
  persisted on the attempt's `payment.providerReference` BEFORE the redirect; never
  reused. The link expires in 25 min, inside the 30-min stock reservation.
- **An order becomes PAID only from an authentic transaction whose amount AND
  currency match ours**: a `transaction.updated` event whose checksum verified, or a
  transaction the API read itself (`GET /v1/transactions/{id}`, private key).
  Mismatch, absent or unreadable → `PAYMENT_MISMATCH` + alert, never `PAID`, and
  only an operator leaves that state.
- **One settlement path** (`WompiSettlementService`) for the webhook
  (`POST /v1/webhooks/wompi`), the return page (`POST /v1/payments/orders/:n/confirm`
  with Wompi's `?id=`) and the 5-minute reconciliation sweep. Deduped on
  `wompi:<transactionId>:<status>` in `provider_event`, in the same transaction as
  the state change, with the order row locked. DECLINED/VOIDED/ERROR → FAILED +
  reservations released; PENDING → order untouched.
- **Verification is ours** (plain SHA-256 checksum over `signature.properties` +
  timestamp + events secret, constant-time), the body is parsed with zod; the webhook
  answers 200 for everything authentic, 400 for a bad checksum, 503 without keys.
  It needs no raw body.
- **Refunds are manual**: Wompi has no refund API for Web Checkout. Staff refund in
  the Wompi dashboard and RECORD it at `POST /v1/admin/orders/:n/refunds`
  (`OrdersService.recordRefund` — the one refund implementation).
- **Sandbox and live are separate key sets**, chosen by `WOMPI_ENVIRONMENT`, pinned
  explicitly on every deployment (the deployed API may run `NODE_ENV=development`;
  production refuses it unset). Base URLs derive from it; key prefixes
  (`pub_test_`/`pub_prod_` …) must match it. Everything reads `config.wompi`.
- `PAYMENTS_ENABLED=false` settles orders locally without taking money — development
  only.

## Storefront (`apps/storefront`)

- **Astro 7, `output: "server"`, Node adapter (standalone).** Every page renders per
  request off the API. `/api/revalidate` verifies the API's HMAC and acknowledges;
  when a CDN/HTML cache is added, purge the `tags` there.
- **Configuration is runtime-only**, read from `process.env` in `src/lib/env.ts`
  (`API_INTERNAL_URL`, `PUBLIC_API_URL`, `PUBLIC_DASHBOARD_URL`, `SESSION_SECRET`,
  `SESSION_COOKIE_NAME`, `REVALIDATE_SIGNING_SECRET`). Public values reach islands as
  PROPS, never via `import.meta.env`, so one image serves every environment.
- **Pages live at their bare paths under `src/pages/`** and links are plain paths.
  `src/middleware.ts` only 301s legacy `/en/*` / `/es/*` URLs (`legacyLocaleRedirect`).
  The API builds absolute storefront URLs with `storefrontUrl(origin, path, query)`
  (`apps/api/src/common/storefront-url.ts`) — e.g. `/checkout/processing?order=…` — so
  do not rename routes the API links to.
- **Every user-visible string lives in `src/i18n/messages.ts`** — one Spanish
  catalogue, `t`. Pages import it; islands receive the slice they need as a prop.
- **Never render a server-supplied message to a shopper.** `ApiError.message` and
  `CartProblem.message` are English for logs. Branch on the closed code enums with
  `errorMessage()` / `t.cartProblems` — total maps, so a new code fails to compile.
- **One HTTP wrapper** (`src/lib/http.ts`) parses every response through its
  `@akai/contracts` schema and throws `ApiError`. Server catalogue reads live in
  `src/lib/catalog.ts`; browser commerce calls in `src/lib/cart-client.ts`. Nothing
  else calls `fetch` against the API.
- **Display fallbacks live in `src/lib/view.ts`** (blank alt → product name, unnamed
  variant → its options → SKU). Names and alt text are plain strings from the API.
- **The sellable unit is the VARIANT.** Variant `options` are `{size}` or
  `{size, color}`; a multi-variant product always shows a picker.
- **Islands** (`src/components/islands/*.tsx`, React): `CartCount`, `AddToCart`,
  `CartView`, `CheckoutForm`, `OrderProcessing`. Cart writes dispatch
  `akai:cart-changed` on `window`; the header badge listens. Everything else is
  `.astro` and ships no JS.
- Checkout fixes the country to Colombia, takes the departamento from
  `COLOMBIAN_DEPARTAMENTOS`, a Colombian mobile and the identity document, and
  offers every rate the quote returns (there is no delivery type any more).
- `@astrojs/react` is in `vite.ssr.noExternal` — deps live at the root, and an
  externalised renderer cannot resolve `astro:react:opts` at runtime.

### Design tokens

Defined once in `src/styles/global.css` `@theme`: `ink #0e0e0e`, `paper #f3efe6`,
`stone #8a857b`, `line #d6d0c3`, `akai #d0231c` (the one accent), `akai-deep`. Fonts:
**Anton** (display, uppercase headlines) and **Zen Kaku Gothic New** (body, Japanese
glyphs). Flat colour, hard 1px ink borders, no rounded corners. Utilities `.btn`,
`.btn-outline`, `.field`, `.label`. Never introduce raw hex values in components.

## TypeScript conventions

- `strict` everywhere, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`.
- The storefront serves `PublicProduct` only; contracts also export the wide `Product`
  (with `onHand`/`reserved`) — never render that shape to shoppers.
- Component props: explicit `interface Props` above the component.

## Testing conventions

Vitest workspace-wide (no Jest). Nest DI under Vitest is proven by
`apps/api/src/nest-di.test.ts` (`unplugin-swc` supplies decorator metadata) — keep it.

- Unit tests sit beside source (`*.test.ts[x]`); integration suites are
  `apps/api-e2e/src/**/*.spec.ts`.
- Environments: `jsdom` for the dashboard, `node` for api/worker/storefront. No
  workspace-global setup file.
- The root pins `vite@7` for Vitest 3; Astro brings its own Vite 8. Do not remove the
  root pin — plugin peers would resolve against Vite 8 and the vitest configs stop
  typechecking.
- `tools/scripts/assert-test-count.mjs` fails CI if a project's test count collapses.
- **Brace the body of a `beforeEach`.** `beforeEach(() => mock.mockReset())` returns the
  mock, and Vitest runs a returned function as TEARDOWN — an unawaited extra call after
  every test.
