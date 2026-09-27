-- THE AFFILIATE PROGRAM — §5 (public application) and §14 (admin panel) of
-- docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md.
--
-- A new entity, "affiliate", plus a nullable FK from the EXISTING "discount"
-- table onto it. NOT the other way around (a single couponId on affiliate):
-- the recorded decision is that one affiliate may hold MULTIPLE coupon codes
-- over time (useful if a code is ever reissued), which is an ordinary
-- many-codes-to-one-affiliate relationship, not a one-to-one.
--
-- "affiliate" is deliberately NOT a login or a customer row — see the
-- Prisma model's own doc comment. It carries only what the request asked
-- for: name, country, social handle, email.

CREATE TABLE "affiliate" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "name"         VARCHAR(200) NOT NULL,
    "country"      CHAR(2)      NOT NULL,
    "socialHandle" VARCHAR(200) NOT NULL,
    "email"        VARCHAR(320) NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "deletedAt"    TIMESTAMP(3),

    CONSTRAINT "affiliate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "affiliate_deletedAt_idx" ON "affiliate"("deletedAt");

COMMENT ON TABLE "affiliate" IS
  'A referral partner. Admin-managed only — never a login, never a customer row. Soft-deleted like everything else here; a deleted affiliate keeps any coupon''s redemption history pointed at it.';

-- THE FK. Nullable — most coupons are not an affiliate's, and this column
-- must not force one. `ON DELETE RESTRICT` matches
-- "discount_redemption_discountId_fkey"'s own choice one table over: nothing
-- in this application hard-deletes an affiliate (soft delete only), so this
-- is defence in depth, not a path the app is expected to hit.
ALTER TABLE "discount" ADD COLUMN "affiliateId" UUID;

ALTER TABLE "discount"
  ADD CONSTRAINT "discount_affiliateId_fkey"
  FOREIGN KEY ("affiliateId") REFERENCES "affiliate"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "discount_affiliateId_idx" ON "discount"("affiliateId");

-- GRANTS ARE NOT INHERITED (see 20260910000000_invoice_counter §5 and
-- 20260915110000_site_settings for the same note) — "affiliate" is a table
-- created after the blanket GRANT in 20260720000100, so it starts with none
-- of it. "discount" already has its grants from that earlier migration; only
-- the new table needs this block.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akai_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "affiliate" TO akai_app';
  ELSE
    RAISE NOTICE
      'Role akai_app not found; skipping affiliate grants. Production MUST provision it — without these grants the application form and the admin affiliates screen both fail.';
  END IF;
END
$$;
