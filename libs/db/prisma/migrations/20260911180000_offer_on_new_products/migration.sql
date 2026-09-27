-- "OFFER THIS ADD-ON ON PRODUCTS THAT DO NOT EXIST YET."
--
-- `POST :id/offer-everywhere` attaches an add-on to every product that exists
-- when it runs. That is a one-time act by design, and it leaves a gap the
-- operator feels immediately: a product created tomorrow does not offer the
-- water that comes free with everything else.
--
-- A FLAG THAT MATERIALISES REAL EDGES, NOT A UNION AT READ TIME. When a product
-- is created, the API writes an ordinary `product_add_on` row for every add-on
-- carrying this flag. So the join table stays the single source of truth: the
-- storefront reads one place, removing the add-on from ONE product is still
-- just deleting its edge, and no "except these" table has to exist. A flag
-- consulted at read time would have cost all three.
ALTER TABLE "product"
  ADD COLUMN "offerOnNewProducts" BOOLEAN NOT NULL DEFAULT false;

-- Which of THIS product's variants those automatic edges pre-select. Carried
-- alongside the flag because the operator chooses it in the same breath —
-- "offer the water everywhere, with the free 3 ml already ticked" is one
-- decision, and splitting it would make the automatic edges silently
-- default-less.
ALTER TABLE "product"
  ADD COLUMN "newProductDefaultVariantId" UUID;

-- THE SAME COMPOSITE-KEY GUARANTEE AS THE EDGE, pointed at the unique that
-- 20260911120000 added for exactly this purpose: the pair must exist, so a
-- default naming another product's variant is rejected by the database rather
-- than only by the service.
--
-- THE COLUMN LIST IS NOT OPTIONAL HERE. The referencing columns are
-- ("id", "newProductDefaultVariantId"), and `id` is this table's PRIMARY KEY.
-- A plain `ON DELETE SET NULL` nulls EVERY referencing column, so deleting a
-- variant would attempt to null the product's own primary key. Naming the
-- column (PostgreSQL 15+; this server is 16) is what makes the rule
-- expressible at all.
--
-- MATCH SIMPLE — the default — satisfies the constraint whenever
-- "newProductDefaultVariantId" IS NULL, which is "these edges pre-select
-- nothing". `id` is never null, so the nullable half is the only one that
-- switches the check off.
ALTER TABLE "product"
  ADD CONSTRAINT "product_newProductDefaultVariantId_fkey"
  FOREIGN KEY ("id", "newProductDefaultVariantId")
  REFERENCES "product_variant"("productId", "id")
  ON DELETE SET NULL ("newProductDefaultVariantId");

COMMENT ON COLUMN "product"."offerOnNewProducts" IS
  'Attach this product as an add-on to every product created from now on. Materialises real product_add_on rows at creation; never consulted at read time.';

-- NOT MODELLED AS A PRISMA RELATION, deliberately. Doing so would mean putting
-- this table''s own @id into a relation''s `fields`, which is a far riskier
-- thing to ask of the schema than the edge''s case. Prisma carries the two
-- columns as plain scalars, which is all the service reads and writes; the
-- constraint above is what enforces them. `prisma migrate dev` would report
-- this as drift — migrations here are hand-written, so that is expected.
--
-- NO GRANT BLOCK: this alters an existing table and grants attach to the table,
-- not to its columns. Both columns are additive with a default or a null, so
-- nothing locks and no row is rewritten.
--
-- APPLY BEFORE DEPLOYING THE API THAT READS IT: `mapProduct` selects both
-- columns, so an API deployed first errors on every product read.
