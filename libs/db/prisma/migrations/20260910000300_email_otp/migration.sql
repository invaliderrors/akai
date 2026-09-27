-- =============================================================================
-- EMAILED ONE-TIME SIGN-IN CODES — THEIR OWN TABLE, NOT `auth_token`.
--
-- `auth_token` already stores single-use, hashed, TTL-bounded secrets, so
-- reusing it for a six-digit code is the obvious move. It is also wrong in
-- three specific ways, each of which passes every unit test:
--
--   1. `tokenHash` is GLOBALLY UNIQUE. A 256-bit token never collides; a
--      six-digit code has 10^6 possible values, so two customers holding the
--      same live code collide on insert. P2002 is translated to a domain error
--      only for `customer.email`, so it would surface as a 500 under
--      concurrency — never in a test.
--   2. Lookup is `findAuthTokenByHash(hash)` — BY HASH ALONE. With a short code
--      that is not a bug but an authentication bypass: a code issued to A
--      authenticates whichever row it happens to match.
--   3. There is no per-token attempt counter. The only counters are
--      `customer.failedLoginCount` (password-shaped) and an IP bucket, neither
--      of which bounds an attacker walking one live code from many addresses.
--
-- SO: the hash is taken over `customerId || ':' || code`, which makes the digest
-- customer-bound — collisions stop being possible and a code cannot be
-- redeemed against another account even if the digest matched. Lookup is BY
-- CUSTOMER, and the code is verified against that row.
--
-- ONE LIVE CODE PER CUSTOMER, enforced by the primary key rather than by an
-- application "delete the old one first", which races with a concurrent
-- request. Issuing is an upsert: a second request replaces the code instead of
-- leaving two valid.
--
-- ROLLBACK: purely additive. The previous application does not know this table
-- exists and is unaffected; a later contraction may drop it.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "email_otp" (
    -- The customer IS the key: one live code each, no second row possible.
    "customerId" UUID        NOT NULL,
    -- SHA-256 hex over `${customerId}:${code}`. Customer-bound, so neither a
    -- collision nor a cross-account redemption is expressible.
    "codeHash"   CHAR(64)    NOT NULL,
    -- Bounds brute force on ONE code. The verifier burns the code when this is
    -- exhausted, so an attacker gets a fixed number of guesses per issuance
    -- rather than a fresh budget per source address.
    "attempts"   INTEGER     NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_otp_pkey" PRIMARY KEY ("customerId"),
    CONSTRAINT "email_otp_customerId_fkey" FOREIGN KEY ("customerId")
      REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "email_otp_attempts_bounded" CHECK ("attempts" >= 0)
);

-- Sized for the retention sweep, which is the only query that reads by expiry.
CREATE INDEX IF NOT EXISTS "email_otp_expiresAt_idx" ON "email_otp" ("expiresAt");

COMMENT ON TABLE "email_otp" IS
  'Emailed one-time sign-in codes. One live code per customer (the customer id is the PK). codeHash is SHA-256 over customerId:code so a code is bound to its account. Never reuse auth_token for this — see this migration.';

-- A table created after 20260720000100 does NOT inherit that migration''s
-- grants, and the failure would surface only at runtime, on the sign-in path.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akai_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "email_otp" TO akai_app';
  ELSE
    RAISE NOTICE
      'Role akai_app not found; skipping email_otp grant. Production MUST provision it.';
  END IF;
END
$$;
