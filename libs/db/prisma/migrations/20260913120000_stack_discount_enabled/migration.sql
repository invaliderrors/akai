-- A FIXED, NON-CONFIGURABLE VOLUME-DISCOUNT SCHEDULE, TOGGLED PER PRODUCT.
--
-- Unlike the freeform tiers `ProductVariantPriceTier` already supports (any
-- admin-typed quantity/price), this flag means "every variant of this product
-- uses the one schedule everybody uses" — 2/3/5/10 units at 10/15/30/40% off,
-- computed from each variant's OWN price by `computeStackDiscountTiers` in
-- @akai/contracts, never typed in. The API recomputes and fully replaces the
-- affected variant's `product_variant_price_tier` rows whenever this is true;
-- this column carries no pricing data itself, only the toggle.
--
-- ADDITIVE, DEFAULT FALSE: every existing product keeps its current tiers (or
-- lack of them) untouched. No backfill, no index — never filtered or queried
-- on, only read per-product.
ALTER TABLE "product"
  ADD COLUMN "stackDiscountEnabled" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "product"."stackDiscountEnabled" IS
  'Applies the fixed volume-discount schedule (2/3/5/10 units, 10/15/30/40% off) to every variant, computed from each variant''s own price. See computeStackDiscountTiers in @akai/contracts.';

-- NO GRANT BLOCK: additive column with a default on an existing table, same
-- reasoning as 20260911180000_offer_on_new_products — nothing locks, no row
-- rewrite beyond the implicit default fill.
--
-- APPLY BEFORE DEPLOYING THE API THAT READS IT: `mapProduct` selects this
-- column unconditionally once changed, same caution as the migration above.
