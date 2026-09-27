-- A SOFT-DELETED CATEGORY MUST STOP OWNING ITS SLUG.
--
-- Categories had no delete path at all until this migration's feature added
-- one (the admin category CRUD screen). `category.slug` carried an
-- UNCONDITIONAL unique index, so the moment a category COULD be deleted, a
-- deleted row would keep its slug forever — the exact fault
-- `20260911190000_release_unique_keys_on_soft_delete` fixed for
-- `product.slug` and `product_variant.sku`, just not hit yet here because
-- nothing had deleted a category before now.
--
-- THE FIX IS THE SAME PATTERN: a PARTIAL unique index, `WHERE "deletedAt" IS
-- NULL`, so a dead row no longer reserves a name nobody can use, and two LIVE
-- categories still cannot share a slug.
--
-- THE NAME IS KEPT so anything reading `pg_indexes` — or a future Prisma
-- diff — still recognises it as the same constraint.

DROP INDEX "category_slug_key";
CREATE UNIQUE INDEX "category_slug_key"
  ON "category" ("slug")
  WHERE "deletedAt" IS NULL;

COMMENT ON INDEX "category_slug_key" IS
  'Unique among LIVE categories only. A soft-deleted category releases its slug so the same name can be recreated.';

-- NO OTHER SCHEMA CHANGE: `sortOrder` and `deletedAt` already exist on
-- "category" from its original migration — this feature is new application
-- code (create/rename/reorder/delete routes) against columns that were
-- already there, not a new column.
