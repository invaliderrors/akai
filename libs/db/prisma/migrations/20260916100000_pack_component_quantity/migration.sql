-- PACK COMPONENT QUANTITY — a pack slot can now claim more than one physical
-- unit of a component ("5x Reta 20mg" as one slot, not five identical slots).
-- See ProductPackComponent's own schema comment and pack-pricing.ts's doc
-- comment for the two-level allocation this drives.

ALTER TABLE "product_pack_component" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;

-- Same ceiling the contract schema enforces on write (generous; the REAL
-- per-line ceiling is MAX_LINE_QUANTITY, enforced dynamically at add-to-cart
-- time against quantity × how many packs are being added — see
-- CartService.addPack).
ALTER TABLE "product_pack_component"
  ADD CONSTRAINT "product_pack_component_quantity_positive"
  CHECK ("quantity" > 0 AND "quantity" <= 20);

COMMENT ON TABLE "product_pack_component" IS
  'The 2-6 products one PACK product is made of, with one pinned variant and a quantity each. Admin-managed only.';

-- WIDEN cart_item_pack_key. Once a component's quantity is > 1, the two-level
-- allocation in pack-pricing.ts can legitimately split ONE component into up
-- to two cart lines at two adjacent per-unit prices (allocate()'s remainder
-- rule guarantees at most two distinct values across identically-weighted
-- units) — so "one row per (cart, variant, pack instance)" is no longer
-- true. "One row per (cart, variant, pack instance, PRICE)" still is, and
-- still catches any genuine duplicate write.
DROP INDEX "cart_item_pack_key";

CREATE UNIQUE INDEX "cart_item_pack_key"
  ON "cart_item" ("cartId", "variantId", "packInstanceId", "unitPriceGross")
  WHERE "packInstanceId" IS NOT NULL;

COMMENT ON INDEX "cart_item_pack_key" IS
  'At most one cart line per (cart, variant, price) within one pack instance — a component with quantity > 1 may legitimately need two, at two adjacent prices.';
