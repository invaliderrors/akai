-- A DEFAULT ADD-ON SELECTION, ON THE EDGE.
--
-- "Free bacteriostatic water with this peptide" is a fact about the PAIR, not
-- about either product on its own: the same water may be free beside one
-- product, a paid upsell beside another, and absent from a third. So the
-- default lives here, next to `sortOrder`, for the very reason this table is an
-- explicit join rather than an implicit m-n — the edge carries data.
--
-- A VARIANT, NOT A BOOLEAN. An add-on sold in 3 ml and 10 ml has no single
-- thing to pre-select, and "the free one" is not something a flag can name.
--
-- A SUGGESTION, NOT A COMMITMENT. Nothing downstream treats this as compulsory:
-- the storefront arrives with it ticked and unticking it is an ordinary
-- interaction. A line a customer could not remove would need the cart to
-- enforce it server-side, which is a different feature with a different shape.
ALTER TABLE "product_add_on" ADD COLUMN "defaultVariantId" UUID;

-- THE COMPOSITE UNIQUE EXISTS TO BE REFERENCED, AND IS REDUNDANT ON PURPOSE.
-- `product_variant`'s primary key is `id` alone, which proves a variant EXISTS
-- but says nothing about WHOSE it is. Carrying `addOnId` into the foreign key
-- below is what turns "the default variant belongs to the add-on it defaults
-- for" into a database guarantee instead of a service convention — the same
-- argument `product_add_on_not_self` makes one migration earlier: the service
-- checks it too and can name the field in a 400, but the service is not the
-- only writer a database ever has.
--
-- The table is small and the index build takes an ACCESS EXCLUSIVE lock only
-- briefly; there is no backfill and no row is rewritten.
ALTER TABLE "product_variant"
  ADD CONSTRAINT "product_variant_productId_id_key" UNIQUE ("productId", "id");

-- MATCH SIMPLE — the default — is what makes the nullable half work: with
-- "defaultVariantId" NULL the constraint is satisfied without checking
-- anything, which is precisely "this edge pre-selects nothing". Set, the PAIR
-- must exist, so a default naming another product's variant is rejected.
--
-- SET NULL NAMES ITS COLUMN. PostgreSQL 15 introduced the column list and this
-- server is 16.15. Plain `ON DELETE SET NULL` would null EVERY referencing
-- column, "addOnId" included — and that column is NOT NULL and half the primary
-- key, so deleting a variant would ERROR instead of clearing the default.
--
-- NO `ON UPDATE CASCADE`, unlike the other foreign keys on this table. A
-- cascade here would rewrite "addOnId" if a variant's "productId" ever changed,
-- silently re-pointing the edge at a different add-on. Nothing updates that
-- column today, and NO ACTION fails loudly if anything ever tries.
ALTER TABLE "product_add_on"
  ADD CONSTRAINT "product_add_on_defaultVariantId_fkey"
  FOREIGN KEY ("addOnId", "defaultVariantId")
  REFERENCES "product_variant"("productId", "id")
  ON DELETE SET NULL ("defaultVariantId");

COMMENT ON COLUMN "product_add_on"."defaultVariantId" IS
  'The add-on variant this host page arrives with pre-selected. NULL pre-selects nothing. A suggestion the shopper may decline, never a compulsory line.';

-- NO GRANT BLOCK, DELIBERATELY. Grants attach to the TABLE, not to its columns,
-- and both tables here already carry them (the blanket grant in 20260720000100
-- and the explicit one in 20260910000500). A new TABLE would need its own; an
-- added column does not.
--
-- ADDITIVE AND SAFE TO APPLY BEFORE THE CODE THAT READS IT. The column is
-- nullable with no backfill. The ordering constraint runs the other way, as it
-- did for the table itself: `mapProduct` selects this column, so an API
-- deployed BEFORE this migration errors on every product read. Apply first,
-- confirm it, then deploy.
