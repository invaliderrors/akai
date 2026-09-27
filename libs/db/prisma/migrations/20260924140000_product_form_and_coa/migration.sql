-- PRODUCT SPEC TABLE AND CERTIFICATE — §9 of
-- docs/superpowers/specs/2026-09-24-client-feedback-changes.md.
--
-- EDITED IN PLACE, NOT FOLLOWED BY A DROP MIGRATION. As first written this
-- migration also added a nullable `purityLabel` column; the client then fixed
-- purity at "≥99% HPLC" on every product, so the field was removed end to
-- end. The migration had not been applied to any persistent database (the
-- local dev database was checked with `prisma migrate status` and showed it
-- pending), so it was rewritten and renamed rather than paired with a
-- drop. Do NOT do this to a migration that has been applied anywhere.
--
-- `form` feeds the FORMA cell of the storefront spec table. NOT NULL with a
-- default, so every existing row gets LYOPHILIZED with no backfill.
--
-- `coaObjectKey` is the product's ONE certificate of analysis — a key in the
-- private COA bucket, never a URL. Nullable: absent means "not uploaded".
--
-- `showCoa` is the admin's visibility switch. NOT NULL DEFAULT false, so no
-- existing product starts offering a certificate nobody chose to publish.

CREATE TYPE "ProductForm" AS ENUM ('LYOPHILIZED', 'SOLUTION', 'CAPSULE', 'OTHER');

ALTER TABLE "product" ADD COLUMN "form" "ProductForm" NOT NULL DEFAULT 'LYOPHILIZED';

ALTER TABLE "product" ADD COLUMN "coaObjectKey" VARCHAR(512);

ALTER TABLE "product" ADD COLUMN "showCoa" BOOLEAN NOT NULL DEFAULT false;
