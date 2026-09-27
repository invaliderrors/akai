-- VOLUME PRICING PER VARIANT: "2 vials €49,49 each" instead of one price forever.
--
-- WHY NOT A DISCOUNT. `discount` is a COUPON: it is keyed by `code`, counts
-- redemptions, carries stacking rules and a minimum subtotal, and is applied
-- because a customer typed something. A volume price is none of those — it is a
-- property of the variant, applied automatically, visible before anything is in
-- the cart. Bending one into the other would put two unrelated meanings on the
-- same row and make "why was this cheaper?" unanswerable.
--
-- minQuantity >= 2, DELIBERATELY. Quantity one is the variant's own
-- `priceGross`, so exactly one place claims the price at qty 1 and the two
-- cannot disagree. A tier row for qty 1 would be a second source of truth for a
-- number the variant already owns.
--
-- ONLY THE UNIT PRICE IS STORED. The reference design also shows a line total
-- and a "−15 %" badge; both are DERIVED at render time from this and the base
-- price. Storing them would let a rounding change drift the badge away from the
-- money actually charged.
CREATE TABLE "product_variant_price_tier" (
  "id"             UUID    NOT NULL DEFAULT gen_random_uuid(),
  "variantId"      UUID    NOT NULL,
  "minQuantity"    INTEGER NOT NULL,
  "unitPriceGross" INTEGER NOT NULL,
  CONSTRAINT "product_variant_price_tier_pkey" PRIMARY KEY ("id")
);

-- ONE TIER PER THRESHOLD PER VARIANT. Two rows at the same minQuantity would
-- make the resolved price depend on row order, which is not a price.
CREATE UNIQUE INDEX "product_variant_price_tier_variant_min_key"
  ON "product_variant_price_tier" ("variantId", "minQuantity");

ALTER TABLE "product_variant_price_tier"
  ADD CONSTRAINT "product_variant_price_tier_min_quantity_check"
  CHECK ("minQuantity" >= 2);

-- A TIER MAY NOT BE NEGATIVE. It MAY exceed the base price — that is a strange
-- decision, not an impossible one, and the database is not the right place to
-- have an opinion about a merchant's pricing.
ALTER TABLE "product_variant_price_tier"
  ADD CONSTRAINT "product_variant_price_tier_price_check"
  CHECK ("unitPriceGross" >= 0);

ALTER TABLE "product_variant_price_tier"
  ADD CONSTRAINT "product_variant_price_tier_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "product_variant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMENT ON TABLE "product_variant_price_tier" IS
  'Volume pricing: the unit price once a line reaches "minQuantity". Quantity 1 is "product_variant"."priceGross". Not a discount — no code, no redemptions, applied automatically.';

-- ADDITIVE AND SAFE TO APPLY BEFORE THE CODE THAT READS IT: the table is created
-- empty, so every variant keeps exactly the price it has today until a tier is
-- entered. The ordering constraint runs the other way — `productInclude` gains a
-- join on this table, so an API deployed BEFORE this migration errors on every
-- product read. Apply first, confirm, then deploy.

-- -----------------------------------------------------------------------------
-- RUNTIME ROLE GRANTS — REQUIRED, because this is a new TABLE. Grants are not
-- inherited: the blanket GRANT in 20260720000100 covered the tables existing at
-- that moment, and a permission error on a table created later is invisible to
-- every test that runs as the owner.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akai_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "product_variant_price_tier" TO akai_app';
  ELSE
    RAISE NOTICE
      'Role akai_app not found; skipping product_variant_price_tier grants. Production MUST provision it.';
  END IF;
END
$$;
