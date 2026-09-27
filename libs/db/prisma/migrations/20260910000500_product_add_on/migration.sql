-- PER-PRODUCT ADD-ONS.
--
-- Until now "add-on" was a single global pool: `product.listed = false`, and the
-- storefront offered every unlisted product on every product page. That is one
-- pool for a catalogue selling peptides that need bacteriostatic water and
-- powders that need a scoop, and it cannot express "this one, with that one".
--
-- AN EXPLICIT JOIN MODEL, not Prisma's implicit m-n, because the edge carries
-- data: `sortOrder` is the operator's merchandising decision and belongs on the
-- relationship, exactly as it does on "product_category".
--
-- THIS DOES NOT REPLACE `product.listed` AND MUST NOT BE CONFUSED WITH IT.
-- `listed` answers "is this merchandised on /products?" — a property of the
-- product. This table answers "which products does THIS page offer?" — a
-- property of the pair. They are orthogonal: a product may be both browsable in
-- the grid and offered beside another one, and attaching a product here must
-- never flip its `listed` flag on its behalf.
CREATE TABLE "product_add_on" (
  "productId" UUID    NOT NULL,
  "addOnId"   UUID    NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "product_add_on_pkey" PRIMARY KEY ("productId", "addOnId")
);

-- A PAGE NEVER OFFERS ITSELF. The service checks this too, because it can
-- return a named 400 rather than a constraint violation — but the service is
-- not the only writer a database ever has.
ALTER TABLE "product_add_on"
  ADD CONSTRAINT "product_add_on_not_self" CHECK ("productId" <> "addOnId");

-- CASCADE ON BOTH SIDES, matching "product_category". Deleting a product takes
-- its edges with it in both directions rather than leaving a row pointing at a
-- product that no longer exists — which the mapper would then need an opinion
-- about on every catalogue read.
ALTER TABLE "product_add_on"
  ADD CONSTRAINT "product_add_on_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_add_on"
  ADD CONSTRAINT "product_add_on_addOnId_fkey"
  FOREIGN KEY ("addOnId") REFERENCES "product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- THE REVERSE-DIRECTION INDEX, AND ONLY THE ID. The composite primary key
-- already serves "the add-ons of this product, in order" through its leading
-- column. This one exists for the addOnId cascade, which without it is a
-- sequential scan of this table per deleted product. `sortOrder` is NOT a
-- second column here: it orders add-ons WITHIN one host, so grouped by add-on
-- it sorts nothing and would only be maintained on every write.
CREATE INDEX "product_add_on_addOnId_idx" ON "product_add_on" ("addOnId");

COMMENT ON TABLE "product_add_on" IS
  'Which products each product page offers as add-ons. Orthogonal to "product"."listed": that flag decides catalogue merchandising, this table decides page-level cross-selling.';

-- ADDITIVE AND SAFE TO APPLY BEFORE THE CODE THAT READS IT — but note which way
-- that safety runs. The table is created empty, so there is no backfill and
-- nothing to lock, and an instance that predates it neither reads nor writes it.
-- The ordering constraint is the OTHER direction: `productInclude` gains a join
-- on this table, so an API deployed BEFORE this migration errors on every
-- product read. Apply this first, confirm it, then deploy.

-- -----------------------------------------------------------------------------
-- RUNTIME ROLE GRANTS — REQUIRED, because this is a new TABLE.
--
-- GRANTS ARE NOT INHERITED. The blanket `GRANT ... ON ALL TABLES` in
-- 20260720000100 applied to the tables that existed at that moment; a table
-- created afterwards has none of it, and the failure is a permission error at
-- runtime that no test running as the owner would ever see.
--
-- DELETE IS INCLUDED, unlike the append-only ledgers. The write path is a full
-- replacement — delete every edge, then re-create the submitted set in order,
-- the shape `replaceCategories` already uses — so without DELETE every save of
-- an add-on list fails.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akai_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "product_add_on" TO akai_app';
  ELSE
    RAISE NOTICE
      'Role akai_app not found; skipping product_add_on grants. Production MUST provision it — without them every add-on save fails and every product read that joins this table errors.';
  END IF;
END
$$;
