# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Project

Akai — an Nx monorepo for a precision sports supplements e-commerce platform.
Bilingual throughout (Spanish default at `/`, English at `/en`, via next-intl).

**WORDPRESS AND WOOCOMMERCE ARE GONE, AND THIS IS SETTLED — do not relitigate it.**
The NestJS API + PostgreSQL + Whop is THE source of truth for products, customers,
carts, orders, payments and email, and the storefront renders entirely off it. There is
no `wp-json`, no CoCart, no mu-plugin, no `wp/` directory and no WP environment variable
left in the repo. Do not reintroduce one, and do not "restore" a Woo code path found in
git history or in an older doc.

**TAGADAPAY IS GONE TOO, AND THAT IS ALSO SETTLED.** The payment provider is **Whop**
(`@whop/sdk`). There is no `@tagadapay/node-sdk` dependency, no `payments/tagada/**`,
no `TAGADA_*` environment variable and no catalog mirror. Do not restore any of it from
git history — most of the current design is the deliberate INVERSE of a TagadaPay
constraint, so a "fix" that looks like the old code is a regression.

`docs/superpowers/**` is **historical context by default, never requirements** — it
describes the superseded Woo-backed design.

**One file in that tree is the exception and is BINDING:**
`docs/superpowers/specs/2026-09-09-whop-integration-contract.md`. It is the Whop design
lock — every payments decision, every recorded deviation, and the evidence each rests
on. Where it disagrees with the code, it wins and the code is the defect; where the code
has to deviate, the contract is amended in the same commit. Treating it as historical
because of the directory it sits in is how the payments plane gets rebuilt from a
superseded design.

`2026-07-21-tagadapay-integration-contract.md` is its SUPERSEDED predecessor and is now
historical like everything else in that tree. It is kept, not deleted, because it is the
record of why several current decisions look the way they do.

## Workspace layout

```
apps/
  storefront/       Next 15 public storefront. Reads apps/api only. Bilingual.
  storefront-e2e/   Playwright specs for the storefront.
  dashboard/        Next 15 customer + admin dashboard. IMPLEMENTED (auth, account, admin).
  dashboard-e2e/    Playwright specs for the dashboard.
  api/              NestJS 11 HTTP API (Express adapter). IMPLEMENTED — 35 modules,
                    7 of them still empty placeholders (see "What is left").
  api-e2e/          Integration suites: supertest + real Postgres via testcontainers.
  worker/           Headless Nest process: pg-boss consumers + cron. SHELL — EMPTY.
libs/
  contracts/        ts-rest routers + zod schemas. Depends on NOTHING but zod.
  db/               Prisma client, schema, migrations, ownership-scoped repos. SERVER ONLY.
  money/            The ONLY money implementation.
  config/           Zod-validated, fail-fast typed env config.
  i18n/             Shared locale routing + locale-aware navigation.
  session/          The ONE sealed-session implementation (AES-256-GCM via Web Crypto,
                    so it runs in Node AND on the Edge), the session payload contract,
                    the double-submit CSRF primitives and the BFF-side token schemas.
                    Used by BOTH Next apps, which SHARE one cookie for single sign-on:
                    same name (`akai_session`), same SESSION_SECRET, and in production
                    a SESSION_COOKIE_DOMAIN parent that spans both hosts.
  ui/               Shared React components. SHELL — barrel only.
  email-templates/  React Email templates, es + en. SHELL — barrel only; the live
                    templates currently sit in apps/api/src/modules/email.
  testing/          Test fakes and builders.
  observability/    Logging, tracing, request-id propagation.
docs/               Historical specs and plans (superseded).

There is no `wp/` directory. It held the mu-plugin and was deleted with WordPress.
```

## What is left to implement

Everything below typechecks, lints and builds — it is registered and importable, and
implements nothing. Do not mistake "the module exists" for "the feature works".

**`apps/worker` — entirely empty.** `WorkerModule` has `imports: []`, `providers: []`, and
nothing starts it. It is a shell waiting for a reason to exist.

**The outbox is NOT undrained — do not "fix" it.** There is no `pg-boss` dependency anywhere
in this repo (every mention of it is a stale comment), and the outbox is a separate
hand-rolled mechanism that does not live in `apps/worker`. `main.ts:190` calls
`app.get(OutboxRunner).start()` after `listen()`, and `main.ts:196` starts the cron sweeps;
both run IN THE API PROCESS, polling with `FOR UPDATE SKIP LOCKED`. Email really is
delivered and pages really are revalidated in production today.

Concluding otherwise leads somewhere bad: either a second dispatcher, or an attempt to
implement `apps/worker` that hits the `@nx/enforce-module-boundaries` wall
(`outbox.runner.ts:27-34` — worker may not import apps/api) and ends in weakening the
boundary rule or duplicating the handlers. Both are worse than what exists.

What IS true of that arrangement: every outbox job is work on the API's HTTP event loop, and
if `listen()` never succeeds nothing drains at all — password resets and sign-up
confirmations included. The health probe checks the database, not whether the poller ticks.

**7 empty `@Module({})` placeholders in `apps/api/src/modules`** — registered in
`AppModule`, zero providers, zero tests:

`audit` · `disputes` · `gdpr` · `invoices` · `metrics` · `notifications` · `pricing`

**`fulfilment` is PARTLY built — Sendcloud.** Spec
`docs/superpowers/specs/2026-09-24-sendcloud-shipping.md` (binding for that work, like the
Whop contract) and plan `docs/superpowers/plans/2026-09-24-sendcloud-shipping.md`. Phases
1–2 exist:
- `config.sendcloud` in `libs/config` — all-or-none keys, `SENDCLOUD_MODE` test|live
  defaulting to TEST, `null` when unset. Nothing else reads SENDCLOUD_*.
- ONE migration, `20260925120000_sendcloud_shipping`, holding the data model for EVERY
  phase: rate mapping (`deliveryType`, `carrierCode`, `sendcloudOptionCode`, transit
  days), the order's rate / pickup-point / house-number / parcel-weight snapshot, the
  Sendcloud shipment columns, and five new `ShipmentStatus` values (whose meaning for an
  order is the total map in `orders/shipment-status.ts`). Later phases should not need
  `schema.prisma`.
- Contracts: quote option `deliveryType`/`carrierName`/transit days; service-point
  search; checkout `servicePointId` and a CHECKOUT-ONLY required phone + `houseNumber`
  (`checkoutShippingAddressSchema` — the address book is unchanged); order DTO
  `shippingMethodName`/`shippingHouseNumber`/`servicePoint`/`shipments[]`; a separate
  `adminOrderSchema` for staff-only shipment detail; admin labels + zones/rates CRUD in
  `contracts/lib/fulfilment.ts`; refusals as `fulfilmentFailureReasonSchema` carried in
  the envelope `reason` (no new `ErrorCode`). Every new response field is `.default()`ed —
  clients deploy first.
- The vendor layer: `SENDCLOUD_CLIENT` (`SendcloudPort`) → `SendcloudClient` (fetch,
  Basic auth, v3, retries, zod-narrowed; 409 on announce = the EXISTING shipment) or
  `NotConfiguredSendcloudClient` (rejects with a coded FULFILMENT_NOT_CONFIGURED 409);
  `sendcloud/test-mode.ts`, the `sendcloud:letter` substitution the label service MUST
  apply; `startFakeSendcloud()` in `libs/testing` for api-e2e.

- LABELS (Phases 4–5) are BUILT, in `fulfilment/labels/` (`LabelsModule`, imported by
  OutboxModule). Labels are bought ONLY when staff click (decision D3) — never on
  payment, so `order-settlement.ts` deliberately produces no `order-fulfilment` row.
  `POST /v1/admin/fulfilment/labels` (≤100, Idempotency-Key REQUIRED) splits
  accepted/skipped via `labelSkipReason` and enqueues one `order-fulfilment` job per
  accepted order; `LabelService.createForOrder` (the ONLY caller of `announceShipment`)
  re-checks eligibility, announces OUTSIDE any transaction, stores the A6 PDF at
  `labels/{orderId}/{parcelId}.pdf` in the PRIVATE `S3_BUCKET_COA` (the API's first
  server-side PUT, via the SigV4 presigner), then records the Shipment + PAID →
  FULFILLING in one transaction. It sends NO mail — "Enviado" is the first carrier scan.
  `external_reference_id` is `order.id`, then `order.id:N` after N cancelled/failed
  attempts (a reference is unique forever at Sendcloud; a crash mid-purchase re-sends the
  SAME reference and the 409 hands back the label already bought). Also: print (our
  stored PDFs merged with `pdf-lib`, request order, ≤200), download (302 to a signed
  GET), cancel (FULFILLING → PAID — the one caller of that edge), retry of a FAILED
  label. Every Sendcloud write goes through ONE `SendcloudWriteThrottle` (90/min).

NOT built yet: the pickup-point search endpoint and checkout verification/snapshotting
(Phase 3 — until then checkout accepts `servicePointId` and `houseNumber` but persists
neither), zones/rates admin (5b), tracking webhook + sweep (6).

`batches` (lots + COA upload) is implemented. `inventory` holds only the admin read
list (`GET /v1/admin/inventory`); stock WRITES live in the catalog module
(`ProductInventoryService.adjust`), not here.

Overselling is guarded: checkout reserves every line through
`ProductInventoryService.reserve` (an atomic guarded UPDATE with a TTL) before it
starts payment, and releases what it took if any line fails. `pricing` is the
remaining empty module with a real job.

`audit` has a concrete waiting job: six `ProductsService` mutations (`update`,
`setPublished`, `softDelete`, `restore`, `deleteVariant`, `addMedia`) no longer accept
an `actorId`, because the only place it was ever recorded was a catalog outbox event
that died with the Whop migration. When `audit` ships, those signatures take it back
alongside somewhere to put it. `price_history.changedBy` and
`inventory_ledger_entry.actorId` still record theirs.

**Two library shells** — `libs/ui` and `libs/email-templates` export only a `LIB_NAME`
constant.

Implemented and tested: `auth`, `payments`, `cart`, `catalog`, `orders`, `users`, `blog`, `batches`,
`admin`, `email`, `discounts`, `shipping`, `checkout`, `categories`, `media`, `outbox`,
`tax`, `revalidation`, `contact`, `health`, `idempotency`, `throttler`, `queue`, `returns`.

`returns` is implemented — controller, service and a closed six-state transition map — and
was long mislisted above as an empty placeholder. It sends NO email of any kind, so a
"whole customer lifecycle" email pass has to treat it as a real flow needing new template
keys, not as a module still to be built.

The outbox's registered consumers are `email`, `storefront.revalidate` and
`order-fulfilment` (Sendcloud labels, produced only by the staff label endpoints).
The catalog-mirror consumers went with the mirror; `catalog.inventory.adjusted`,
`invoice-pdf` and `notifications` still dead-letter visibly at /admin/jobs, which is the
deliberate convention for a topic whose module has not shipped.

## Commands

**pnpm only. Never `npm install`** — there is one pnpm lockfile, and a second dependency
graph is a real hazard.

```bash
pnpm install
pnpm dev                  # storefront on :3000
pnpm dev:dashboard        # dashboard on :3001
pnpm build                # nx run-many -t build
pnpm typecheck            # nx run-many -t typecheck
pnpm test                 # nx run-many -t test
pnpm lint                 # nx run-many -t lint
pnpm e2e                  # nx run-many -t e2e
pnpm affected             # typecheck,lint,test,build on affected projects only

pnpm nx run storefront:test                    # one project
pnpm nx run storefront:build --skip-nx-cache   # bypass the Nx cache
```

Env: copy `.env.example`. The storefront reads its own `apps/storefront/.env.local` —
Next resolves env from the app root, not the workspace root.

## Non-negotiable engineering rules

1. **Zero `any`.** No `as any`, no `@ts-ignore`, no `@ts-expect-error` to silence a real
   error, no non-null assertion (`!`) used to dodge a type error. Use `unknown` +
   narrowing for external data. Wrap loose library types in a typed adapter.
   ESLint enforces this repo-wide.
2. **Validate every external input at the boundary** with zod (`.strict()` on request
   schemas = whitelist + forbidNonWhitelisted). The static type must be earned at runtime,
   not asserted.
3. **Money is INTEGER minor units end-to-end.** Never floats, never `Decimal`. Format only
   through `libs/money`.
4. **No secrets in code.** All config flows through `libs/config`, which fails fast on boot.
5. **Every module ships tests.** TDD: failing test → minimal implementation → pass → commit.
6. **Never fabricate passing results.** Run the command; report the real output.

## Architecture facts that span files

**Module boundaries are mechanically enforced** by `@nx/enforce-module-boundaries` at
`error`. Tags live in each `project.json`:

- `scope:web` (storefront, dashboard) → may depend on `scope:shared` only.
- `scope:server` (api, worker) → may depend on `scope:shared` + `scope:server`.
- `libs/db` is `scope:server`, so a Next app importing it is a **lint error** — this is the
  only thing keeping Prisma out of a browser bundle.
- `libs/contracts` is `type:contract` and may depend on nothing.

**`@/*` is app-local**, mapped in each Next app's own tsconfig to that app's `./src`. It is
deliberately NOT in `tsconfig.base.json`: one shared `@/*` could only point at one app, so
a dashboard import would silently resolve into storefront source. `paths` is a **shallow
override** — declaring it in an app config replaces the base block entirely, so
cross-project `@akai/*` aliases must be repeated there. Cross-project imports always use
`@akai/*`.

**tsconfig.base.json has no `include`.** Every project supplies its own, so a NestJS file
can never be swallowed into the Next.js program. `apps/api/tsconfig.app.json` pins
`useDefineForClassFields: false` — `target: ES2022` flips it true by default and silently
destroys decorator metadata, producing opaque runtime DI failures rather than compile errors.

**Everything user-facing is translated.** UI strings live in
`apps/storefront/messages/{es,en}.json` — never hardcode user-visible text. Import
`Link` / `useRouter` / `usePathname` from `@/i18n/navigation`, never from `next/link` or
`next/navigation`. ESLint enforces this; the navigation module itself is the one exemption.

**`src/` and `messages/` must never be separated.** `src/i18n/request.ts` loads
translations through a template-literal dynamic import that is invisible to both tsc and
eslint. Split them and typecheck and lint stay green while every page 500s at runtime.
`apps/storefront-e2e/src/locale-smoke.spec.ts` is the only guard against this — do not
delete it.

**Compliance is structural.** The EU food-supplement disclaimer renders in the storefront's
root layout `<Footer />` (`data-testid="compliance-disclaimer"`), so no page can omit it.
Don't move it into individual pages.

**The storefront reaches the API through ONE client**, `apps/storefront/src/lib/api/`.
Every function there parses its response against a `@akai/contracts` schema and throws a
typed `ApiError` carrying the platform's error envelope; no page or component declares a
response shape, and none calls `fetch` against the API directly.

**The browser talks to the API directly, with ONE deliberate exception: auth.** Cart,
contact and shipping quotes go straight to the API, for two reasons that still hold. The
cart's session is an `x-cart-token` header the API lists in CORS `exposedHeaders`, and the
API's throttle guard derives its key from the socket address and does NOT trust
`X-Forwarded-For` — so proxying `/v1/contact` through a route handler would put every
submission in the world into one bucket and turn a per-IP limit into a site-wide one.

**The store and the dashboard share ONE session.** Same cookie name, same
`SESSION_SECRET`, so a customer who signs in on either arrives at the other already
authenticated, and a sign-out in either ends both. In development they are ports on
`localhost` and cookies ignore the port, so no domain is needed. In production they are
different hosts (`akai.shop` and `app.akai.shop`), so `SESSION_COOKIE_DOMAIN` must
be set to a parent spanning them (`.akai.shop`) in BOTH apps — unset, the cookie is
host-only and the hand-off silently does not happen. A parent-domain cookie is sent to
EVERY subdomain underneath it, so never widen it to a domain that also hosts third-party
or user-controlled content.

Sign-in is the exception, and it is forced: `POST /v1/auth/login` returns a token pair
whose own contract says it "must never be forwarded to a browser". So
`apps/storefront/src/app/api/` now holds FOUR route handlers — `revalidate` (inbound),
plus `auth/login`, `auth/logout` and `auth/session`, the first two of which hold the token
pair server-side in a sealed httpOnly cookie. Do not widen that set casually: anything the
browser can call directly, it should. The bar for a new one is that it handles TOKEN
MATERIAL. Proxying an endpoint that does not is actively harmful, because the API's
throttle guard keys on the socket address with `trust proxy` deliberately unset — routing
it through the storefront container turns a per-IP budget into one bucket for the whole
world (`lib/api/contact.ts:13-29` records the same reasoning).

**A locale-keyed value is resolved in ONE place.** `translations[]`, `media[].alt`,
`category.name` and `variant.name` all arrive per-locale. `apps/storefront/src/lib/catalog/view.ts`
owns the fallback chain (active locale → `es` → first row). Three pages had grown their
own near-identical copies before it existed; do not write a fourth.

## Payments — this SUPERSEDES every earlier rule

The former standing rules *"checkout is a redirect, never a form"* and *"never build
payment/checkout UI in Next.js"* are **deliberately obsolete**. Checkout redirects to
**Whop hosted checkout**. There is no Stripe and no TagadaPay code in this repository.

- **Our API is the source of truth, in the STRONG sense.** Whop's checkout call takes
  our computed `grandTotal` directly, so the number we compute is the number charged.
  Nothing is mirrored, so nothing can drift.
- **THERE IS NO CATALOG MIRROR, and do not build one.** TagadaPay's checkout accepted
  `{ variantId, quantity }` and no amount, which made a mirrored catalog the only channel
  through which a price could reach the payment page — hence `providerVariantId`,
  `ProductSyncService`, the `catalog.*` outbox topics and a checkout that refused to run
  against an unmirrored variant. All of it is deleted. Publishing a product and being
  able to sell it are no longer coupled through a queue, and sync failure is not a class
  of outage this system has.
- **Discounts work.** A discounted order is simply a smaller `initialPrice`. The old
  `DiscountsUnsupportedError` refusal is gone.
- **An order becomes PAID only via a signature-verified webhook whose reported amount
  matches our own.** The browser return URL renders a "processing" state and polls. A
  client-side success redirect is forged in ten seconds.
- **The webhook's reported amount is untrusted input.** A mismatch — or an absent or
  unreadable amount — moves the order to `PAYMENT_MISMATCH` and alerts. It never becomes
  `PAID`.
- **Compare `data.total`, NEVER `data.amount_after_fees`.** Both are on the payload; the
  latter is net of Whop's platform fee, so comparing it would mismatch every order.
- **Webhook verification is the VENDOR'S; parsing is ours.** This reverses the TagadaPay
  decision on evidence: `unwrapWebhook` is exported from `@whop/sdk/helpers`, does honest
  Standard Webhooks verification (signature AND a five-minute timestamp window), and
  handles a `ws_`-secret base64 quirk we would get wrong by hand. But its `TEvent`
  generic is an unchecked assertion, so it is called with NO type argument and the body
  is parsed through zod. See `payments/webhook/whop-webhook.verify.ts`.
- **Money crosses the boundary in exactly two functions.** Whop speaks major units in
  three dialects (exact decimal strings on REST, floats on webhooks, floats on requests);
  `libs/money`'s `toDecimalString` / `fromDecimalString` own all of it, with integer and
  string arithmetic only. `fromDecimalString` REJECTS excess precision rather than
  rounding — a total we cannot read exactly is a total we must not agree with.
- **SANDBOX AND LIVE ARE SEPARATE WHOP ACCOUNTS**, selected at boot by
  `WHOP_ENVIRONMENT` (`sandbox` | `live`), which DEFAULTS from `NODE_ENV` but is
  pinned explicitly on the deployment. That pin is load-bearing: the deployed API
  deliberately runs `NODE_ENV=development`, so the default alone would resolve the
  LIVE deployment to sandbox and mark real customers' orders `PAID` without taking
  money. Unprefixed `WHOP_*` is the LIVE set; `WHOP_SANDBOX_*` is the other one.
  There is no `WHOP_BASE_URL` — it is derived, because a live key 401s against the
  sandbox host and two variables that must agree is a way to get it wrong.
- **Everything reads `config.whop`**, resolved once in `libs/config`. No consumer
  picks an environment for itself.
- The grand total is **always** recomputed server-side. The API never accepts an amount
  from the client.
- Full contract: `docs/superpowers/specs/2026-09-09-whop-integration-contract.md` —
  **binding, not historical**, notwithstanding the `docs/superpowers/**` default above.
  It is the only file in that tree with that status; see the note at the top of this file.

## TypeScript conventions

- `strict` everywhere, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`.
  **Known exception:** `apps/storefront` scopes off the first two, recorded as tech debt in
  its `tsconfig.json`, because the migration required moving it untouched. New code does
  not get that exemption.
- `apps/storefront/src/lib/types.ts` DECLARES NOTHING. It is a curated re-export of
  `@akai/contracts`, and the curation is the point: contracts also exports `Product`,
  the WIDE projection carrying `inventory.onHand`, `reserved` and `lowStockThreshold`.
  The storefront serves `PublicProduct` and must never render anything else, so a
  component reaching for the wide shape has to import it from somewhere this file
  deliberately is not.
- Any older doc describing a Woo `prices: ProductPrices` block, `item_key`, `item_count`
  or numeric product ids is describing a shape that no longer exists.
- Route handlers take `NextRequest` (not `Request`) so they stay directly testable in Vitest.
- Component props: explicit `interface XxxProps` above the component. Callbacks typed
  precisely (`(itemKey: string, quantity: number) => Promise<void>`, not `Function`).

## Component conventions

- **Server components by default.** `"use client"` only where state/effects/browser APIs
  are needed. Current client components: `CartProvider`, `Header`, `ProductGrid`,
  `ProductCatalog`, `ProductPurchasePanel`, `AddToCart`, `CheckoutForm`,
  `CheckoutProcessing`, `VialRail`, `BestSellersCarousel`, `CoaViewer` (the in-page
  PDF.js certificate dialog — `pdfjs-dist` is imported only when it opens), and the cart
  and contact pages. Dialog mechanics (focus trap, Escape, inert page, scroll lock) live
  in ONE hook, `src/lib/dialog/use-modal-dialog.ts`, shared by `CartDrawer` and `CoaViewer`.
  `ProductJsonLd` is deliberately a SERVER component: structured data injected after
  hydration is read inconsistently by crawlers and not at all by the ones that do not run
  JavaScript.
- **Pure display components take props, not context.** `ProductCard` receives
  `{ product }`; it never fetches or reads providers. Fetch high, render pure.
- **All API communication goes through `@/lib/api`.** Components never call `fetch`
  against the API origin themselves. Server components fetch and pass plain props down.
- **The sellable unit is the VARIANT.** `AddToCart` takes `{ variantId: string }` and the
  cart API takes a variant UUID; there is no product-level add, because a product with two
  sizes has no single price. A multi-variant product needs a picker
  (`ProductPurchasePanel`), not a hidden default.
- **Never render a server-supplied message to a customer.** `ApiError.message`,
  `cartProblem.message` and the like are English written for a log. Branch on the CLOSED
  enum (`ApiError.code`, `problem.code`) against `messages/{es,en}.json`. Typing the map
  as a total `Record` over the enum makes a new code a compile error rather than a blank
  alert.
- **Context comes from one provider** (`CartProvider`), wired once in
  `[locale]/layout.tsx`. Access via `useCart` (throws outside the provider).
- Reuse before creating: `ProductGrid` has `showFilters` (catalog vs. home variants);
  `FaqAccordion` takes `entries`. Prefer a prop on an existing component over a fork.

## Testing conventions

Vitest workspace-wide (no Jest). Nest DI under Vitest is **proven working** by
`apps/api/src/nest-di.test.ts` — `unplugin-swc` supplies the decorator metadata that
esbuild drops. Keep that test; it is an architecture gate, not a feature test.

- Unit tests sit beside source: `apps/*/src/**/*.test.{ts,tsx}`, `libs/*/src/**/*.test.ts`.
- Integration suites are `apps/api-e2e/src/**/*.spec.ts`.
- Environments: `jsdom` for the Next apps, `node` for api/worker. There is **no**
  workspace-global setup file — `apps/storefront/vitest.setup.ts` (which stubs
  `NEXT_PUBLIC_API_URL`, since `apiOrigin()` throws without it) must never be inherited by
  the API.
- `server.deps.inline: ['next-intl']` is preserved verbatim in both Next apps' vitest
  configs. Dropping it reintroduces a "Cannot find module" resolution failure.
- The storefront `test` target deliberately omits `--passWithNoTests` (the shells have it):
  a glob that silently matches zero files must fail rather than look green.
- Mock at the module boundary: components mock `@/lib/api` with `vi.mock`; the clients in
  `lib/api/` stub global `fetch` with `vi.stubGlobal`. Cookie-dependent tests must clear
  cookies in `beforeEach`/`afterEach` (jsdom persists them across tests in a file).
- Catalog fixtures come from `apps/storefront/src/test/catalog-fixtures.ts`, which PARSES
  through `publicProductSchema` rather than casting. A fixture that has drifted from the
  contract must fail in the test that uses it, not pass against a shape the API cannot send.
- **Brace the body of a `beforeEach`.** `beforeEach(() => mock.mockReset())` returns the
  mock, and Vitest treats a function returned from a hook as a TEARDOWN callback — so the
  mock is invoked once more after every test with nobody awaiting it. On a rejecting mock
  that surfaces as an unhandled rejection blamed on the test that just passed. This cost a
  real investigation and was once documented as an unfixable React 19 / jsdom artifact.

## Design tokens

"Specimen label" lab aesthetic, defined once in `apps/storefront/src/app/globals.css`
`@theme`. **Light / royal-blue theme:**

- `--color-base: #ffffff`, `--color-surface: #f3f4f8`, `--color-line: rgba(13,15,21,.11)`
- `--color-accent: #2b2fd9` (indigo), `--color-accent-bright: #5256ff`,
  `--color-accent-ink: #2326c0`
- Use as Tailwind classes: `bg-base`, `bg-surface`, `border-line`, `text-accent`.

Fonts (loaded in `apps/storefront/src/app/[locale]/layout.tsx`): **Schibsted Grotesk**
(sans), **Instrument Serif** (display), **JetBrains Mono** (mono — reserved for the
wordmark, prices, purity figures and REF/batch metadata).

Atmosphere (graph-paper grid, grain overlay) and the `.reveal` stagger animation live in
`globals.css` — reuse them, don't re-implement per page. Accent is for data highlights, not
decoration. Never introduce raw hex values in components.

Tailwind v4 roots content detection at the app package, so each Next app's `globals.css`
declares an explicit `@source` for `libs/ui`. Without it, lib utility classes are silently
never generated — no error, just unstyled UI.
