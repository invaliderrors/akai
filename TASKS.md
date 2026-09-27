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
- [ ] Remove batches/lots + certificate-of-analysis (COA bucket, `coaObjectKey`, `showCoa`, `/coa` endpoints, admin UI)
- [ ] Remove supplement-only product fields (`ProductForm`, peptide/country legality notes, supplement tax wording)
- [ ] Replace supplement seed catalog + images with a streetwear placeholder catalog
- [ ] Neutralise supplement copy in dashboard messages and email templates

## 3. Database
- [ ] Squash all Prisma migrations into one fresh `init` migration (plus invariants SQL)
- [ ] Verify `prisma migrate reset` + seed against a clean Postgres

## 4. Astro storefront (`apps/storefront`)
- [x] Scaffold Astro 7 (SSR, `@astrojs/node`), React islands, Tailwind v4, Nx targets (dev/build/start/typecheck/test/lint)
- [x] Workspace on Node 22.12+ (Astro 7 requirement; Node 20 is EOL)
- [x] i18n: `es` default at `/`, `en` at `/en` (middleware rewrite; pages written once under `[locale]/`)
- [x] Typed API client over `@akai/contracts` (server catalog reads, browser cart/checkout client)
- [x] Session: reads the dashboard's shared sealed cookie; sign-in/account link to the dashboard
- [x] `/api/revalidate` verifies the API's HMAC (acknowledge-only until a cache exists)
- [x] Pages: home, products (+category filter, cursor paging), product (variant picker), cart, checkout (Whop redirect), checkout/processing (status poll), 404
- [x] First pass of the visual identity (ink / washi / hanko red, Anton + Zen Kaku Gothic New)
- [x] Dockerfile + docker-compose service
- [ ] Pickup-point (SERVICE_POINT) delivery at checkout — blocked on the API's service-point search (Sendcloud Phase 3)
- [ ] Discount code field in cart
- [ ] Legal pages (terms, privacy, returns) + footer links; `TERMS_VERSION` in `src/lib/legal.ts`
- [ ] SEO: sitemap, canonical URLs, product JSON-LD, OG images
- [ ] Blog / lookbook pages (API `blog` module exists)
- [ ] Brand design pass (real photography, lookbook layouts, motion)
- [ ] `storefront-e2e` Playwright project (browse → add to cart → checkout redirect)

## 5. Docs & verification
- [ ] Rewrite CLAUDE.md and README.md for Akai
- [ ] `.env.example` storefront section for Astro
- [ ] typecheck, lint, test, build green; CI green
- [ ] Confirm production domain (placeholder `akai.shop`)
