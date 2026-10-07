-- =============================================================================
-- Invariants Prisma's schema language cannot express.
--
-- `20260927000000_init` is generated verbatim by
--   prisma migrate diff --from-empty --to-schema-datamodel schema.prisma --script
-- This companion carries everything that generator cannot produce: CHECK
-- constraints, partial and expression indexes, composite foreign keys with a
-- column-list SET NULL, sequences and SQL functions, append-only triggers,
-- runtime-role grants and the two singleton rows.
--
-- These are NOT optional hardening. Each one closes a defect that application
-- code alone cannot close, because application code races against itself the
-- moment there is more than one process. Prisma's `migrate diff` does not see
-- most of them (CHECKs, predicates, triggers, grants), so "no drift" from Prisma
-- is not evidence they exist — `apps/api-e2e` asserts the load-bearing ones
-- against a real database.
--
-- Squashed on 2026-09-27 from the platform's earlier migration history (the
-- store's database is new; there was no data to carry). The reasoning each
-- block records is preserved from the migration that introduced it.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. MONEY AND QUANTITY INVARIANTS
--
-- A negative price or a negative stock level is not a state the domain has a
-- meaning for. Enforcing it here means a bug produces a failed transaction
-- instead of a corrupt row that is discovered months later during an audit.
-- -----------------------------------------------------------------------------

ALTER TABLE "product_variant"
  ADD CONSTRAINT "product_variant_price_net_non_negative"   CHECK ("priceNet" >= 0),
  ADD CONSTRAINT "product_variant_price_tax_non_negative"   CHECK ("priceTax" >= 0),
  ADD CONSTRAINT "product_variant_price_gross_non_negative" CHECK ("priceGross" >= 0),
  -- Makes it structurally impossible to store a price whose parts do not add
  -- up, so an invoice can never fail to foot because of a rounding bug upstream.
  ADD CONSTRAINT "product_variant_price_components_sum"     CHECK ("priceNet" + "priceTax" = "priceGross"),
  ADD CONSTRAINT "product_variant_tax_rate_range"           CHECK ("taxRateBps" BETWEEN 0 AND 10000);

-- THE oversell guard. Stock decrement is a single conditional UPDATE
--   UPDATE inventory_item SET "onHand" = "onHand" - n WHERE "variantId" = ? AND "onHand" >= n
-- and a zero-row result IS the rejection. Never read-then-write. This CHECK is
-- the backstop for any code path that forgets.
ALTER TABLE "inventory_item"
  ADD CONSTRAINT "inventory_on_hand_non_negative"   CHECK ("onHand" >= 0),
  ADD CONSTRAINT "inventory_reserved_non_negative"  CHECK ("reserved" >= 0),
  -- Reserved stock that exceeds stock on hand means we have promised goods we
  -- do not have.
  ADD CONSTRAINT "inventory_reserved_within_onhand" CHECK ("reserved" <= "onHand");

ALTER TABLE "cart_item"
  ADD CONSTRAINT "cart_item_quantity_positive" CHECK ("quantity" > 0 AND "quantity" <= 99);

ALTER TABLE "order_item"
  ADD CONSTRAINT "order_item_quantity_positive"      CHECK ("quantity" > 0),
  ADD CONSTRAINT "order_item_money_non_negative"     CHECK (
    "unitPriceNet" >= 0 AND "unitPriceGross" >= 0 AND "lineDiscount" >= 0
    AND "taxAmount" >= 0 AND "lineTotalNet" >= 0 AND "lineTotalGross" >= 0
  ),
  ADD CONSTRAINT "order_item_tax_rate_range"         CHECK ("taxRateBps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "order_item_line_components_sum"    CHECK ("lineTotalNet" + "taxAmount" = "lineTotalGross");

ALTER TABLE "order"
  ADD CONSTRAINT "order_money_non_negative" CHECK (
    "subtotal" >= 0 AND "discountTotal" >= 0 AND "shippingTotal" >= 0
    AND "taxTotal" >= 0 AND "grandTotal" >= 0 AND "refundedTotal" >= 0
  ),
  -- You cannot refund more than you charged.
  ADD CONSTRAINT "order_refund_within_total" CHECK ("refundedTotal" <= "grandTotal");

ALTER TABLE "payment"
  ADD CONSTRAINT "payment_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "refund"
  ADD CONSTRAINT "refund_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "stock_reservation"
  ADD CONSTRAINT "stock_reservation_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "shipment_item"
  ADD CONSTRAINT "shipment_item_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "tax_rate"
  ADD CONSTRAINT "tax_rate_range" CHECK ("rateBps" BETWEEN 0 AND 10000);

-- Volume pricing. minQuantity >= 2 DELIBERATELY: quantity one is the variant's
-- own `priceGross`, so exactly one place claims the price at qty 1. A tier may
-- exceed the base price (a strange decision, not an impossible one) but may not
-- be negative.
ALTER TABLE "product_variant_price_tier"
  ADD CONSTRAINT "product_variant_price_tier_min_quantity_check" CHECK ("minQuantity" >= 2),
  ADD CONSTRAINT "product_variant_price_tier_price_check"        CHECK ("unitPriceGross" >= 0);

-- A pack component quantity is a small positive count ("3x Tee Black M").
ALTER TABLE "product_pack_component"
  ADD CONSTRAINT "product_pack_component_quantity_positive" CHECK ("quantity" > 0 AND "quantity" <= 20);


-- -----------------------------------------------------------------------------
-- 2. SHAPE AND DOMAIN CHECKS
-- -----------------------------------------------------------------------------

-- Shipping method names are per-locale JSON. `narrowLocalizedText` in the API
-- degrades an unparseable record to "no name" (and the selector then refuses to
-- offer the rate), but that is a read-side guard: this is what stops a manual
-- UPDATE writing a bare string or an array in the first place.
ALTER TABLE "shipping_rate"
  ADD CONSTRAINT "shipping_rate_name_is_object" CHECK (jsonb_typeof("name") = 'object');

-- A PAGE NEVER OFFERS ITSELF. The service checks this too, to return a named
-- 400 — but the service is not the only writer a database ever has.
ALTER TABLE "product_add_on"
  ADD CONSTRAINT "product_add_on_not_self" CHECK ("productId" <> "addOnId");

-- Bounds brute force on ONE emailed sign-in code.
ALTER TABLE "email_otp"
  ADD CONSTRAINT "email_otp_attempts_bounded" CHECK ("attempts" >= 0);

ALTER TABLE "affiliate_link"
  ADD CONSTRAINT "affiliate_link_slug_format"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") >= 2);

ALTER TABLE "blog_post"
  ADD CONSTRAINT "blog_post_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- A published post always has a date to sort and display by.
  ADD CONSTRAINT "blog_post_published_has_date"
  CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);

-- The buyer's identity document, as `normaliseDocumentNumber` (libs/contracts)
-- writes it: uppercase alphanumerics, plus at most one "-D" check digit (a NIT).
-- The per-type rules (digits only for CC/TI, …) live in the contract; this is the
-- backstop against a writer that skipped it.
ALTER TABLE "order"
  ADD CONSTRAINT "order_document_number_format"
  CHECK ("documentNumber" ~ '^[0-9A-Z]+(-[0-9])?$');

-- SINGLETONS BY CONSTRUCTION: `id` is a boolean pinned to true, so the primary
-- key doubles as the "there is exactly one row" constraint.
ALTER TABLE "invoice_counter"
  ADD CONSTRAINT "invoice_counter_singleton" CHECK ("id" = true),
  ADD CONSTRAINT "invoice_counter_positive"  CHECK ("lastNumber" >= 0);

ALTER TABLE "site_settings"
  ADD CONSTRAINT "site_settings_singleton" CHECK ("id" = true);


-- -----------------------------------------------------------------------------
-- 3. PARTIAL / EXPRESSION UNIQUE INDEXES
--
-- Prisma cannot express a WHERE clause on an index, so these columns carry NO
-- `@unique` in schema.prisma — declaring one would make the generated init
-- build the unconditional index these replace.
-- -----------------------------------------------------------------------------

-- Unique among LIVE rows only: a soft-deleted product/variant/category keeps its
-- row for order history but RELEASES its slug/SKU, so it can be created again.
CREATE UNIQUE INDEX "product_slug_key"
  ON "product" ("slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "product_variant_sku_key"
  ON "product_variant" ("sku") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "category_slug_key"
  ON "category" ("slug") WHERE "deletedAt" IS NULL;

COMMENT ON INDEX "product_slug_key" IS
  'Unique among LIVE products only. A soft-deleted product releases its slug so the same product can be recreated.';
COMMENT ON INDEX "product_variant_sku_key" IS
  'Unique among LIVE variants only. A soft-deleted variant releases its SKU.';
COMMENT ON INDEX "category_slug_key" IS
  'Unique among LIVE categories only. A soft-deleted category releases its slug so the same name can be recreated.';

-- Option-combination uniqueness per product ({"size":"M","color":"black"}). A
-- jsonb equality index is the only way to express "no two variants of one
-- product share an option set".
CREATE UNIQUE INDEX "product_variant_options_unique"
  ON "product_variant" ("productId", "options")
  WHERE "deletedAt" IS NULL;

-- Exactly ONE default address per (customer, type). An application "clear the
-- others first" races with a concurrent create; only the database can decide
-- that race. Partial on `deletedAt` so deleting and re-adding a default works.
CREATE UNIQUE INDEX "address_one_default_per_type"
  ON "address" ("customerId", "type")
  WHERE "isDefault" AND "deletedAt" IS NULL;

-- "One line per variant" is TWO partial unique indexes. A single
-- UNIQUE (cartId, variantId, packInstanceId) would NOT do: NULLs are distinct
-- in a unique index, so it would stop enforcing "one standalone line per
-- variant" altogether.
CREATE UNIQUE INDEX "cart_item_standalone_key"
  ON "cart_item" ("cartId", "variantId")
  WHERE "packInstanceId" IS NULL;
CREATE UNIQUE INDEX "cart_item_pack_key"
  ON "cart_item" ("cartId", "variantId", "packInstanceId", "unitPriceGross")
  WHERE "packInstanceId" IS NOT NULL;

COMMENT ON INDEX "cart_item_standalone_key" IS
  'At most one STANDALONE cart line per (cart, variant).';
COMMENT ON INDEX "cart_item_pack_key" IS
  'At most one cart line per (cart, variant, price) within one pack instance — a component with quantity > 1 may legitimately need two, at two adjacent prices.';


-- -----------------------------------------------------------------------------
-- 4. PARTIAL HOT-PATH INDEXES
-- -----------------------------------------------------------------------------

-- The public catalog query: active, non-deleted products only.
CREATE INDEX "product_active_idx"
  ON "product" ("createdAt" DESC)
  WHERE "deletedAt" IS NULL AND "status" = 'ACTIVE';

-- The reservation-expiry cron scans exactly this predicate.
CREATE INDEX "stock_reservation_pending_idx"
  ON "stock_reservation" ("expiresAt")
  WHERE "releasedAt" IS NULL;

-- The outbox dispatcher polls exactly this predicate; without a partial index it
-- degrades into a full scan as processed rows accumulate.
CREATE INDEX "outbox_pending_idx"
  ON "outbox_message" ("availableAt")
  WHERE "processedAt" IS NULL AND "deadAt" IS NULL;


-- -----------------------------------------------------------------------------
-- 5. COMPOSITE FOREIGN KEYS WITH A COLUMN-LIST `SET NULL`
--
-- Both point at `product_variant ("productId", "id")` (the
-- `product_variant_productId_id_key` unique index), so the database itself
-- rejects a default variant that belongs to some OTHER product. Deleting that
-- variant nulls ONLY the variant column — `ON DELETE SET NULL (col)` — which
-- Prisma cannot express (it would null the non-nullable product column too).
-- Prisma's `migrate diff` therefore reports these two as drift; that is
-- expected and has always been the case.
-- -----------------------------------------------------------------------------

-- Prisma generated this one as ON DELETE RESTRICT; replace it under the same name.
ALTER TABLE "product_add_on" DROP CONSTRAINT "product_add_on_addOnId_defaultVariantId_fkey";
ALTER TABLE "product_add_on"
  ADD CONSTRAINT "product_add_on_addOnId_defaultVariantId_fkey"
  FOREIGN KEY ("addOnId", "defaultVariantId")
  REFERENCES "product_variant" ("productId", "id")
  ON DELETE SET NULL ("defaultVariantId") ON UPDATE CASCADE;

-- No Prisma relation at all (it would put Product's own @id into a relation's
-- `fields`); the service reads and writes the scalar.
ALTER TABLE "product"
  ADD CONSTRAINT "product_newProductDefaultVariantId_fkey"
  FOREIGN KEY ("id", "newProductDefaultVariantId")
  REFERENCES "product_variant" ("productId", "id")
  ON DELETE SET NULL ("newProductDefaultVariantId");


-- -----------------------------------------------------------------------------
-- 6. ORDER NUMBERS AND THE GAP-FREE INVOICE COUNTER
--
-- Order numbers are human-facing and MAY have gaps (a cancelled checkout is
-- allowed to burn one), so a sequence is right for them.
--
-- INVOICE numbers may NOT have gaps — a legal requirement in most EU member
-- states — and a sequence structurally cannot promise that: `nextval` is
-- non-transactional, so a settlement that rolls back, or a losing concurrent
-- UPDATE whose target-list `nextval` was evaluated before the tuple lock, burns
-- a number permanently (measured on postgres:16-alpine). The fix is a ROW, not a
-- sequence: `invoice_counter` is updated under its own lock, rolls back with its
-- transaction, and a competing allocation waits. Allocation happens once per
-- order, only at PAID, so that contention is not a cost worth avoiding.
-- -----------------------------------------------------------------------------

CREATE SEQUENCE "order_number_seq" AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Renders AK-YYYY-NNNNNN. The year comes from the allocation date, so numbering
-- reads naturally to a human even though the sequence itself never resets.
CREATE FUNCTION next_order_number() RETURNS text AS $$
  SELECT 'AK-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('order_number_seq')::text, 6, '0');
$$ LANGUAGE sql VOLATILE;

-- THE SUPERSEDED INVOICE MECHANISM, kept callable because
-- `OrdersService.markPaid` still references it; the live settlement path uses
-- `allocate_invoice_number()` below.
CREATE SEQUENCE "invoice_number_seq" AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE FUNCTION next_invoice_number() RETURNS text AS $$
  SELECT 'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0');
$$ LANGUAGE sql VOLATILE;

COMMENT ON FUNCTION next_invoice_number() IS
  'DEPRECATED — NOT TRANSACTIONAL. nextval is not rolled back, so a settlement that aborts burns a number permanently. Use allocate_invoice_number().';
COMMENT ON SEQUENCE "invoice_number_seq" IS
  'DEPRECATED — superseded by "invoice_counter".';

COMMENT ON TABLE "invoice_counter" IS
  'Singleton, transactional invoice-number counter. Never DELETE the row: numbering would restart at 1 and re-issue numbers that are already on filed invoices.';

-- One row, forever. `lastNumber` is the number most recently ISSUED, so a fresh
-- counter reads 0 and issues 000001.
INSERT INTO "invoice_counter" ("id", "lastNumber") VALUES (true, 0)
ON CONFLICT ("id") DO NOTHING;

-- INSERT … ON CONFLICT DO UPDATE rather than a bare UPDATE because it is
-- SELF-SEEDING: anything that empties the table (a TRUNCATE, a restore, the
-- integration harness resetting between tests) would otherwise turn every
-- settlement into a silent no-op. The conflict path takes the same exclusive
-- row lock a plain UPDATE would. The re-seed floor is DERIVED from what has
-- actually been issued — never a literal 1 — so it can only move forward.
--
-- Format `INV-YYYY-NNNNNN`, the year from the allocation date, from a counter
-- that never resets. NEVER call this in the target list of a conditional
-- UPDATE: a WHERE that fails to match would still have bumped the counter.
CREATE FUNCTION allocate_invoice_number() RETURNS text AS $$
  INSERT INTO "invoice_counter" ("id", "lastNumber")
  VALUES (
    true,
    COALESCE(
      (SELECT MAX((substring("invoiceNumber" from '([0-9]+)$'))::bigint)
         FROM "order"
        WHERE "invoiceNumber" ~ '^INV-[0-9]{4}-[0-9]+$'),
      0
    ) + 1
  )
  ON CONFLICT ("id") DO UPDATE SET "lastNumber" = "invoice_counter"."lastNumber" + 1
  RETURNING 'INV-' || to_char(now(), 'YYYY') || '-' || lpad("lastNumber"::text, 6, '0');
$$ LANGUAGE sql VOLATILE;

COMMENT ON FUNCTION allocate_invoice_number() IS
  'Allocates the next gap-free invoice number INSIDE the calling transaction. A rollback returns the number to the series.';


-- -----------------------------------------------------------------------------
-- 7. SITE SETTINGS SINGLETON ROW
--
-- Read at request time (the maintenance toggle). The row exists from the start
-- so the first read is not a 500; the repository also self-seeds.
-- -----------------------------------------------------------------------------

COMMENT ON TABLE "site_settings" IS
  'Singleton row of admin-togglable, DB-backed settings — read at request time, not at boot. Never DELETE the row.';

INSERT INTO "site_settings" ("id", "maintenanceMode", "updatedAt")
VALUES (true, false, now())
ON CONFLICT ("id") DO NOTHING;


-- -----------------------------------------------------------------------------
-- 8. DOCUMENTATION COMMENTS
-- -----------------------------------------------------------------------------

COMMENT ON COLUMN "product"."listed" IS
  'False = ADD-ON: hidden from the /products listing but still reachable by slug and purchasable. Not a visibility or access control — use "status" to make a product unsellable.';
COMMENT ON COLUMN "product"."offerOnNewProducts" IS
  'Attach this product as an add-on to every product created from now on. Materialises real product_add_on rows at creation; never consulted at read time.';
COMMENT ON COLUMN "product"."stackDiscountEnabled" IS
  'Applies the fixed volume-discount schedule to every variant, computed from each variant''s own price. See computeStackDiscountTiers in @akai/contracts.';
COMMENT ON COLUMN "product"."sortOrder" IS
  'Catalogue-wide manual display order, lower first. Read only by the "manual" ProductSort mode; every other sort ignores it.';
COMMENT ON TABLE "product_add_on" IS
  'Which products each product page offers as add-ons. Orthogonal to "product"."listed": that flag decides catalogue merchandising, this table decides page-level cross-selling.';
COMMENT ON COLUMN "product_add_on"."defaultVariantId" IS
  'The add-on variant this host page arrives with pre-selected. NULL pre-selects nothing. A suggestion the shopper may decline, never a compulsory line.';
COMMENT ON TABLE "product_variant_price_tier" IS
  'Volume pricing: the unit price once a line reaches "minQuantity". Quantity 1 is "product_variant"."priceGross". Not a discount — no code, no redemptions, applied automatically.';
COMMENT ON TABLE "product_pack_component" IS
  'The 2-6 products one PACK product is made of, with one pinned variant and a quantity each. Admin-managed only.';
COMMENT ON TABLE "affiliate" IS
  'A referral partner. Soft-deleted like everything else here; a deleted affiliate keeps any coupon''s redemption history pointed at it.';
COMMENT ON TABLE "email_otp" IS
  'Emailed one-time sign-in codes. One live code per customer (the customer id is the PK). codeHash is SHA-256 over customerId:code so a code is bound to its account. Never reuse auth_token for this.';
COMMENT ON COLUMN "email_event"."dedupeScope" IS
  'Widens the idempotency key beyond (order, template). Empty string = the whole order. A shipment id scopes a per-parcel send. NOT NULL on purpose: NULLs are distinct for uniqueness in Postgres, so a nullable scope would let duplicates through.';


-- -----------------------------------------------------------------------------
-- 9. APPEND-ONLY ENFORCEMENT
--
-- "An audit table the app can UPDATE is not an audit table." Two layers,
-- because either alone is insufficient: (a) triggers, which stop even a
-- superuser's careless UPDATE; and (b) the role grants below, which stop the
-- application entirely.
-- -----------------------------------------------------------------------------

CREATE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted. Correct a bad entry by appending a compensating one.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "inventory_ledger_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_ledger"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();


-- -----------------------------------------------------------------------------
-- 10. RUNTIME ROLE GRANTS
--
-- Migrations run as the OWNER role; the application connects as `akai_app`
-- (created locally by tools/postgres/init/01-init.sql; a production deploy
-- prerequisite). The runtime role simply has no UPDATE or DELETE privilege on
-- the append-only tables, so even a SQL-injection foothold in the app cannot
-- rewrite history.
--
-- GRANTS ARE NOT INHERITED BY LATER TABLES. `ON ALL TABLES` covers the tables
-- that exist NOW; a migration that creates a table must grant on it
-- explicitly, or the failure surfaces only at runtime, as a permission error no
-- test running as the owner will ever see.
--
-- Guarded with a DO block so a database without the role still migrates.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akai_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO akai_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO akai_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO akai_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION allocate_invoice_number() TO akai_app';

    -- Append-only: take the mutating privileges back.
    EXECUTE 'REVOKE UPDATE, DELETE ON "audit_log" FROM akai_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON "inventory_ledger" FROM akai_app';
    -- Provider webhook dedupe is insert-only too: deleting a processed event id
    -- would let a replayed webhook re-apply a state change.
    EXECUTE 'REVOKE UPDATE, DELETE ON "provider_event" FROM akai_app';

    -- Singletons and soft-deleted records the application never hard-deletes.
    -- Deleting the invoice counter row would restart numbering at 1 and
    -- re-issue numbers already on filed invoices.
    EXECUTE 'REVOKE DELETE ON "invoice_counter" FROM akai_app';
    EXECUTE 'REVOKE DELETE ON "site_settings" FROM akai_app';
    EXECUTE 'REVOKE DELETE ON "affiliate" FROM akai_app';
  ELSE
    RAISE NOTICE
      'Role akai_app not found; skipping runtime grants. Production MUST provision it — the append-only guarantee depends on the app not owning these tables.';
  END IF;
END
$$;
