-- REAL PRODUCT PACKS — §1 of
-- docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md.
--
-- A pack is an ordinary "product" row with kind = 'PACK', carrying exactly one
-- variant whose priceGross IS the flat admin-typed pack price. That variant is
-- NEVER added to a cart or order — "add pack to cart" resolves this pack's
-- pinned components and adds THEIR real variants instead, which is what lets
-- checkout, inventory reservation, tax resolution and the Whop payment call
-- all work completely unchanged. See ProductPackComponent's own comment.

CREATE TYPE "ProductKind" AS ENUM ('SIMPLE', 'PACK');

ALTER TABLE "product" ADD COLUMN "kind" "ProductKind" NOT NULL DEFAULT 'SIMPLE';

CREATE INDEX "product_kind_idx" ON "product"("kind");

-- THE COMPONENT LIST. Mirrors "product_add_on" closely, with one deliberate
-- difference: "componentVariantId" is NOT NULL. An add-on's default variant is
-- a suggestion the shopper may decline; a pack's pinned variant IS the sale —
-- the admin pins it, the shopper never chooses (recorded decision).
CREATE TABLE "product_pack_component" (
    "packProductId"      UUID    NOT NULL,
    "componentProductId" UUID    NOT NULL,
    "componentVariantId" UUID    NOT NULL,
    "sortOrder"          INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_pack_component_pkey" PRIMARY KEY ("packProductId", "componentProductId")
);

CREATE INDEX "product_pack_component_componentProductId_idx" ON "product_pack_component"("componentProductId");

ALTER TABLE "product_pack_component"
  ADD CONSTRAINT "product_pack_component_packProductId_fkey"
  FOREIGN KEY ("packProductId") REFERENCES "product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE (unlike the pack side above): a product that is a
-- live pack component must not vanish out from under the pack it belongs to.
-- The service layer additionally refuses to soft-delete a product still
-- referenced here (409) — soft delete is a plain UPDATE and this FK cannot
-- see it coming, so the application-level guard is the one that actually
-- fires in practice; this is defence in depth for a hard delete, the same
-- shape "discount_affiliateId_fkey" already chose one migration ago.
ALTER TABLE "product_pack_component"
  ADD CONSTRAINT "product_pack_component_componentProductId_fkey"
  FOREIGN KEY ("componentProductId") REFERENCES "product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- COMPOSITE, carrying componentProductId into the reference so the database
-- itself rejects a pinned variant that belongs to some OTHER product — the
-- exact mechanism "product_add_on_addOnId_defaultVariantId_fkey" already uses
-- against product_variant's own (productId, id) unique key.
ALTER TABLE "product_pack_component"
  ADD CONSTRAINT "product_pack_component_component_variant_fkey"
  FOREIGN KEY ("componentProductId", "componentVariantId") REFERENCES "product_variant"("productId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON TABLE "product_pack_component" IS
  'The 3-6 products one PACK product is made of, with one pinned variant each. Admin-managed only.';

-- CART GROUPING. Set together, or both null. Every component line of one
-- pack purchase shares the same packInstanceId, minted once per "add pack to
-- cart" event.
ALTER TABLE "cart_item" ADD COLUMN "packProductId"  UUID;
ALTER TABLE "cart_item" ADD COLUMN "packInstanceId" UUID;

-- "ONE LINE PER VARIANT" NO LONGER HOLDS UNCONDITIONALLY. It is now two
-- partial unique indexes rather than one plain composite, because Postgres
-- treats every NULL as distinct from every other NULL in a unique index — a
-- single UNIQUE ("cartId","variantId","packInstanceId") would silently stop
-- enforcing "one standalone line per variant" at all, since every standalone
-- add's NULL packInstanceId would never collide with the last one's NULL.
-- The split preserves that existing rule while letting the SAME variant
-- appear as its own standalone line AND, separately, inside a pack instance
-- — correctly priced differently in each.
DROP INDEX "cart_item_cartId_variantId_key";

CREATE UNIQUE INDEX "cart_item_standalone_key"
  ON "cart_item" ("cartId", "variantId")
  WHERE "packInstanceId" IS NULL;

CREATE UNIQUE INDEX "cart_item_pack_key"
  ON "cart_item" ("cartId", "variantId", "packInstanceId")
  WHERE "packInstanceId" IS NOT NULL;

-- A plain (non-unique) index for lookups that don't care whether a line is
-- standalone or part of a pack — the two partial indexes above only serve
-- queries that already know which case they're in.
CREATE INDEX "cart_item_cartId_variantId_idx" ON "cart_item"("cartId", "variantId");

COMMENT ON INDEX "cart_item_standalone_key" IS
  'At most one STANDALONE cart line per (cart, variant) — the original invariant, preserved.';
COMMENT ON INDEX "cart_item_pack_key" IS
  'At most one cart line per (cart, variant) within one pack instance.';

-- ORDER-SIDE GROUPING. Carried over from cart_item at order-creation time,
-- unchanged, purely for display/reporting. No uniqueness constraint —
-- order_item never had one.
ALTER TABLE "order_item" ADD COLUMN "packProductId"  UUID;
ALTER TABLE "order_item" ADD COLUMN "packInstanceId" UUID;

-- GRANTS ARE NOT INHERITED (see 20260910000000_invoice_counter §5 and every
-- migration since that adds a table) — "product_pack_component" is created
-- after the blanket GRANT in 20260720000100, so it starts with none of it.
-- The three ALTERed tables (product, cart_item, order_item) already have
-- their grants from that earlier migration; only the new table needs this.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akai_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "product_pack_component" TO akai_app';
  ELSE
    RAISE NOTICE
      'Role akai_app not found; skipping product_pack_component grants. Production MUST provision it — without these grants creating or editing a pack fails.';
  END IF;
END
$$;
