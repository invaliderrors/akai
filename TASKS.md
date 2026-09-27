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
- [ ] Scaffold Astro (SSR, `@astrojs/node`), React islands, Tailwind v4, Nx project targets
- [ ] i18n: `es` default at `/`, `en` at `/en`
- [ ] Typed API client over `@akai/contracts`
- [ ] BFF endpoints: `/api/auth/{login,logout,session,otp/verify}` and `/api/revalidate` using `@akai/session`
- [ ] Pages: home, catalog/collection, product (size/colour variants), cart, checkout redirect (Whop), order status
- [ ] Streetwear visual identity (Japanese-style)
- [ ] Dockerfile + docker-compose service, e2e project

## 5. Docs & verification
- [ ] Rewrite CLAUDE.md and README.md for Akai
- [ ] `.env.example` storefront section for Astro
- [ ] typecheck, lint, test, build green; CI green
- [ ] Confirm production domain (placeholder `akai.shop`)
