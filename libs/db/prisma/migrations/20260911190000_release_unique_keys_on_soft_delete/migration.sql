-- A SOFT-DELETED PRODUCT MUST STOP OWNING ITS SLUG AND ITS SKUs.
--
-- Deleting a product sets `deletedAt` and flips it to ARCHIVED; the row stays,
-- because order history points at it. But `product.slug` and
-- `product_variant.sku` carried UNCONDITIONAL unique indexes, so the dead row
-- kept the names forever: recreating the same product with the same data failed
-- on a duplicate key, surfaced to the operator as an unexplained "conflicting
-- data". The only way out was to invent a different slug and different SKUs for
-- a product that is, to everyone who uses the shop, the same product.
--
-- THE FIX IS THE PATTERN THIS SCHEMA ALREADY USES. `product_variant_options_unique`
-- on this very table is `WHERE "deletedAt" IS NULL`, and
-- `address_one_default_per_type` is documented in schema.prisma as a partial
-- unique that Prisma's schema language cannot express and the migration must
-- create. These two are the same kind of rule and were simply missed.
--
-- THE NAMES ARE KEPT so anything reading `pg_indexes` — or a future Prisma
-- diff — still recognises them.
--
-- UNIQUENESS AMONG LIVE ROWS IS UNCHANGED: two live products still cannot share
-- a slug, and two live variants still cannot share a SKU. What changes is that a
-- DEAD row no longer reserves a name nobody can use.

DROP INDEX "product_slug_key";
CREATE UNIQUE INDEX "product_slug_key"
  ON "product" ("slug")
  WHERE "deletedAt" IS NULL;

DROP INDEX "product_variant_sku_key";
CREATE UNIQUE INDEX "product_variant_sku_key"
  ON "product_variant" ("sku")
  WHERE "deletedAt" IS NULL;

COMMENT ON INDEX "product_slug_key" IS
  'Unique among LIVE products only. A soft-deleted product releases its slug so the same product can be recreated.';
COMMENT ON INDEX "product_variant_sku_key" IS
  'Unique among LIVE variants only. A soft-deleted variant releases its SKU.';

-- NOT ADDRESSED HERE, AND SAID SO OUT LOUD: `product_slug_history.slug` is also
-- unconditionally unique, so a slug that a product was RENAMED away from stays
-- reserved even after that product is deleted. That table is empty today and it
-- is a different rule — "this URL once meant that product", which is what keeps
-- old links working — so releasing it needs its own decision about redirects
-- rather than being folded into this fix.
--
-- NO GRANTS: this alters indexes on existing tables. No row is rewritten, and
-- the two CREATEs take a brief lock on tables of this size.
