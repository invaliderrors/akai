-- THE CATALOGUE-WIDE MANUAL DISPLAY ORDER — GLOBAL, NOT PER-CATEGORY.
--
-- `product_category.sortOrder` already orders a product WITHIN one category,
-- but nothing orders the catalogue as a whole; every listing today falls back
-- to `createdAt`, price or a locale-collated name. This column is the missing
-- axis: an admin-set position read only by the new `"manual"` `ProductSort`
-- mode (`product-query.ts`) — every other mode ignores it, so setting this
-- never silently changes what "Price asc" or "Best sellers" render.
--
-- ADDITIVE, DEFAULT 0: every existing product keeps rendering in whatever
-- order its OTHER sort mode already produced (0 breaks no tie until an admin
-- deliberately reorders something). No backfill needed.
ALTER TABLE "product"
  ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN "product"."sortOrder" IS
  'Catalogue-wide manual display order, lower first. Read only by the "manual" ProductSort mode; every other sort ignores it.';

-- INDEXED: the "manual" sort's keyset pagination orders by (sortOrder, id),
-- the same shape every other `SortPlan` in `product-query.ts` already needs
-- an index for. Named to match Prisma's own default for `@@index([sortOrder])`
-- (`<table>_<column>_idx`), the same convention `product_createdAt_idx` and
-- every other single-column index in this schema already follows.
CREATE INDEX "product_sortOrder_idx" ON "product"("sortOrder");

-- NO GRANT BLOCK, NO ROW REWRITE BEYOND THE IMPLICIT DEFAULT FILL: additive
-- column with a default on an existing table, same reasoning as
-- 20260913120000_stack_discount_enabled.
--
-- APPLY BEFORE DEPLOYING THE API THAT READS IT: `mapProduct`/`product-query.ts`
-- select and order by this column unconditionally once changed, same caution
-- as the migration above.
