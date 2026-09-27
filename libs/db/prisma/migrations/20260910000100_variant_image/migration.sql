-- One image per product VARIANT.
--
-- The image lives on `media_asset`, the table that already holds product
-- images, behind a NULLABLE `variantId`. A gallery image has it NULL; a variant
-- image has it set. There is no join table because the requirement is exactly
-- one image per variant, and a many-to-many would be machinery for a case
-- nobody has asked for.
--
-- THIS MIGRATION IS ADDITIVE AND MUST BE SAFE TO APPLY BEFORE THE CODE THAT
-- READS IT. Migrations do not run in the app container (see apps/api/Dockerfile),
-- so the column exists for some period while every running instance still writes
-- and reads product-gallery media only — which is precisely what NULL means
-- here. No backfill, no NOT NULL, no rewrite of an existing row, and therefore
-- no long lock on a table the storefront reads on every product page.

-- ADD COLUMN with no default and no NOT NULL is a catalog-only change in
-- Postgres 11+: metadata, not a table rewrite.
ALTER TABLE "media_asset" ADD COLUMN "variantId" UUID;

-- ON DELETE CASCADE matches every other variant-scoped sibling (batch,
-- price_history, inventory_ledger, stock_reservation): deleting a variant takes
-- its image with it rather than orphaning a row that points at a vanished SKU.
-- Adding the constraint scans the table to validate it, which is trivial here
-- because every existing row is NULL and NULL trivially satisfies an FK.
ALTER TABLE "media_asset"
  ADD CONSTRAINT "media_asset_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "product_variant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- "At most one image per variant", expressed as a UNIQUE index on a NULLABLE
-- column. Postgres treats NULLs as distinct, so this constrains variant images
-- without touching the product gallery, where many rows share a NULL variantId.
-- Enforcing it here rather than with an application "delete the old one first"
-- is the same reasoning as `address_single_default` in
-- 20260720000100_invariants_sequences_grants: the application version races with
-- a concurrent write and leaves two rows the read side must then break a tie on.
--
-- It doubles as the index for the two reads this feature adds — "the image for
-- these variants" and the FK's cascade lookup — so no separate
-- `media_asset_variantId_idx` is created.
CREATE UNIQUE INDEX IF NOT EXISTS "media_asset_variantId_key"
  ON "media_asset" ("variantId");

-- No GRANT is issued. The runtime role's privileges are table-level
-- (`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES`), and a new column on an
-- already-granted table inherits them; only a new TABLE or SEQUENCE would need
-- a grant here.
