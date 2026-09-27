# api-e2e

Integration suites for `apps/api`.

Per the architecture spec §12 these run supertest against a **real** Postgres
via `@testcontainers/postgresql`, with per-suite schema isolation,
`prisma migrate deploy`, and transactional rollback between tests.

The payment gateway and Email are bound to fakes from `@akai/testing`. The
TagadaPay fake (`buildSignedTagadaEvent` / `buildForgedTagadaEvent`) produces
bytes that the REAL verifier in `payments/webhook/tagada-signature.ts` actually
verifies, so signature verification is genuinely exercised rather than stubbed
past — an unsigned-payload test proves nothing about the endpoint that matters
most.

Specs use the `*.spec.ts` suffix here (unit tests elsewhere use `*.test.ts`).
