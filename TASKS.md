# Akai — bootstrap task list

Akai is a Japanese-style streetwear shop built on the API + dashboard platform
inherited from the nexumlabs codebase. This list tracks the work to make it a
fresh, shop-agnostic base with a new Astro storefront.

## 1. Fork & rename
- [x] Copy tracked files from nexumlabs (no git history, no storefront, no client docs)
- [x] Rename every `nexum` / `Nexum Labs` / `NX-` identifier to `akai` / `Akai` / `AK-`
- [x] Remove the Next.js storefront and its root config references (tsconfig, vitest, eslint, compose)
- [x] Initial commit + push to github.com/invaliderrors/akai

## 2. Strip the supplement domain
- [x] Remove batches/lots + certificate of analysis (model, endpoints, admin UI)
- [x] Remove `ProductForm` / `Product.form` and supplement/peptide copy; blog categories → DROPS, LOOKBOOK, STYLE_GUIDES, NEWS
- [x] Dashboard variant editor takes free-text size + optional colour (`{size}` / `{size, color}`)
- [x] Streetwear placeholder seed catalogue (6 products, 23 variants, 4 categories)

## 3. Database
- [x] Squash migrations into `20260927000000_init` + `20260927000100_invariants`
- [x] Verified: `migrate deploy` on an empty DB, seed, API + storefront end to end (browse → cart → checkout → processing, order `AK-2026-000001`)

## 4. Astro storefront (`apps/storefront`)
- [x] Scaffold Astro 7 (SSR, `@astrojs/node`), React islands, Tailwind v4, Nx targets (dev/build/start/typecheck/test/lint)
- [x] Workspace on Node 22.12+ (Astro 7 requirement; Node 20 is EOL)
- [x] Spanish only: pages at their bare paths under `src/pages/`; middleware 301s old `/en/*` links
- [x] Typed API client over `@akai/contracts` (server catalog reads, browser cart/checkout client)
- [x] Session: reads the dashboard's shared sealed cookie; sign-in/account link to the dashboard
- [x] `/api/revalidate` verifies the API's HMAC (acknowledge-only until a cache exists)
- [x] Pages: home, products (+category filter, cursor paging), product (variant picker), cart, checkout (Wompi Web Checkout redirect), checkout/processing (return-page confirm + status poll), 404
- [x] First pass of the visual identity (ink / washi / hanko red, Anton + Zen Kaku Gothic New)
- [x] Dockerfile + docker-compose service
- [ ] Discount code field in cart
- [ ] Legal pages (terms, privacy, returns) + footer links; `TERMS_VERSION` in `src/lib/legal.ts`
- [ ] SEO: sitemap, canonical URLs, product JSON-LD, OG images
- [ ] Blog / lookbook pages (API `blog` module exists)
- [ ] Brand design pass (real photography, lookbook layouts, motion)
- [ ] `storefront-e2e` Playwright project (browse → add to cart → checkout redirect)

## 5. Docs & verification
- [x] Rewrite CLAUDE.md and README.md for Akai
- [x] `.env.example` storefront section for Astro
- [x] typecheck, lint, test, build green locally (15 projects)
- [x] CI green on GitHub (Verify + Integration against real Postgres)

## 6. Colombia
- [x] Remove Sendcloud end to end (fulfilment module, labels, tracking webhook/sweep, `order-fulfilment` /
      `shipment-sync` topics, SENDCLOUD_* config, private label bucket `S3_BUCKET_PRIVATE`, `pdf-lib`,
      dashboard label UI, api-e2e suites, the Sendcloud spec)
- [x] Manual shipping kept and surfaced in the dashboard: record carrier + tracking (free text), mark delivered
- [x] COP everywhere (integer centavos; displayed and entered in whole pesos, es-CO formatting)
- [x] IVA 19% (STANDARD), 5% (REDUCED) for CO; EU VAT-number / reverse-charge fields removed
- [x] Destinations = `["CO"]`; one "Colombia" zone, one national rate ($ 15.000, free from $ 300.000)
- [x] Colombian address: departamento (closed list of 33, DANE codes), ciudad, optional postal code,
      Colombian mobile; no house number
- [x] Identity document at checkout (CC, CE, NIT, PP, TI, PPT), snapshotted on the order
- [x] Seed catalogue in realistic COP prices
- [x] Payments: Whop → Wompi Web Checkout (signed URL, checksum-verified events, return-page
      confirmation, reconciliation sweep, manual refunds recorded from the Wompi dashboard;
      `docs/specs/wompi-integration.md`)
- [x] Spanish only, end to end: no `Locale` enum or `locale` columns; product/blog copy and
      category/variant/media/shipping-rate names are single Spanish fields; no `/en` routes
      (storefront 301s them); dashboard without the `[locale]` segment (next-intl kept as the
      single `es` message catalogue); Spanish-only emails; DeepL translation module and
      `@akai/i18n` removed; dates in es-CO, America/Bogota
- [ ] Colombian invoicing (DIAN electronic invoice) — not started

## 7. Before launch
- [ ] Confirm the production domain (placeholder `akai.shop`) and `SESSION_COOKIE_DOMAIN`
- [ ] Real shipping rates/carriers for Colombia (seed is one $ 15.000 national rate, free from $ 300.000)
- [ ] Create the Wompi sandbox account; set its four keys (`WOMPI_ENVIRONMENT=sandbox`) and its
      event URL `https://<api>/v1/webhooks/wompi`; run the WOMPI-VERIFY list in
      `docs/specs/wompi-integration.md` §10 against it
- [ ] Wompi production account: the four `prod` keys, `WOMPI_ENVIRONMENT=live` pinned, event URL
      `https://<api>/v1/webhooks/wompi` set in the production dashboard
- [ ] A consumer for the `notifications` outbox topic (payment-mismatch, duplicate-payment,
      payment-after-failure and webhook-unparsable alerts currently dead-letter at `/admin/jobs`)
- [ ] Real catalogue, photography and copy; replace seed placeholders
- [ ] Legal texts (terms, privacy, returns, imprint)
- [ ] Turnstile keys, SMTP provider, S3/CDN for media
- [ ] API placeholders still empty: audit, disputes, gdpr, invoices, metrics, notifications, pricing
