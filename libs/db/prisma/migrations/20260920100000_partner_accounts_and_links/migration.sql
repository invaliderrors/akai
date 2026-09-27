-- Partner accounts (Role.PARTNER, Affiliate.customerId) and vanity link click
-- tracking (AffiliateLink, AffiliateLinkClick).
--
-- Hand-curated rather than a raw `prisma migrate diff` output: a diff against
-- this database's migration history also surfaced several unrelated,
-- pre-existing constraint/index NAME drifts on product/product_add_on/
-- product_pack_component/product_variant_price_tier (cosmetic renames from
-- an earlier Prisma version's naming, not anything this feature touches).
-- Included here is only what schema.prisma's new Affiliate/AffiliateLink/
-- AffiliateLinkClick/Role changes actually require.

-- AlterEnum
-- Must commit before any statement in a LATER transaction can reference the
-- new value — fine here, since nothing below inserts a Role.PARTNER row.
ALTER TYPE "Role" ADD VALUE 'PARTNER';

-- AlterTable
ALTER TABLE "affiliate" ADD COLUMN "customerId" UUID;

-- CreateTable
CREATE TABLE "affiliate_link" (
    "id" UUID NOT NULL,
    "affiliateId" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "affiliate_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_link_click" (
    "id" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_link_click_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_customerId_key" ON "affiliate"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_link_slug_key" ON "affiliate_link"("slug");

-- CreateIndex
CREATE INDEX "affiliate_link_affiliateId_idx" ON "affiliate_link"("affiliateId");

-- CreateIndex
CREATE INDEX "affiliate_link_click_linkId_idx" ON "affiliate_link_click"("linkId");

-- Lowercase alphanumeric + internal hyphens, 2-80 chars, no leading/trailing
-- hyphen. Prisma cannot express a CHECK constraint, so this is raw SQL, same
-- pattern as this schema's other hand-added CHECKs (e.g.
-- product_pack_component_quantity_positive). Case-insensitive uniqueness
-- against reserved storefront route segments is enforced at the application
-- layer (the admin create endpoint), since that list lives in code, not SQL.
ALTER TABLE "affiliate_link"
  ADD CONSTRAINT "affiliate_link_slug_format"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") >= 2);

-- AddForeignKey
ALTER TABLE "affiliate" ADD CONSTRAINT "affiliate_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customer"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_link" ADD CONSTRAINT "affiliate_link_affiliateId_fkey"
  FOREIGN KEY ("affiliateId") REFERENCES "affiliate"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_link_click" ADD CONSTRAINT "affiliate_link_click_linkId_fkey"
  FOREIGN KEY ("linkId") REFERENCES "affiliate_link"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
