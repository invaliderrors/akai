-- =============================================================================
-- Invariants Prisma's schema language cannot express.
--
-- These are NOT optional hardening. Each one closes a defect that application
-- code alone cannot close, because application code races against itself the
-- moment there is more than one process — which there is, by design
-- (apps/api + apps/worker).
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
  -- The single most valuable line in this file: it makes it structurally
  -- impossible to store a price whose parts do not add up, so an invoice can
  -- never fail to foot because of a rounding bug upstream.
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

ALTER TABLE "batch"
  ADD CONSTRAINT "batch_purity_range" CHECK ("purityPercent" >= 0 AND "purityPercent" <= 100);

ALTER TABLE "tax_rate"
  ADD CONSTRAINT "tax_rate_range" CHECK ("rateBps" BETWEEN 0 AND 10000);

-- -----------------------------------------------------------------------------
-- 2. SEQUENCES
--
-- Order numbers are human-facing and may have gaps (a cancelled checkout is
-- allowed to burn one). INVOICE numbers may NOT have gaps — that is a legal
-- requirement in most EU member states — which is why they are allocated only
-- at PAID and never at cart creation.
-- -----------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS "order_number_seq"   AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS "invoice_number_seq" AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Renders AK-YYYY-NNNNNN. The year comes from the allocation date, so numbering
-- reads naturally to a human even though the sequence itself never resets.
CREATE OR REPLACE FUNCTION next_order_number() RETURNS text AS $$
  SELECT 'AK-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('order_number_seq')::text, 6, '0');
$$ LANGUAGE sql VOLATILE;

CREATE OR REPLACE FUNCTION next_invoice_number() RETURNS text AS $$
  SELECT 'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0');
$$ LANGUAGE sql VOLATILE;

-- -----------------------------------------------------------------------------
-- 3. PARTIAL / EXPRESSION INDEXES
--
-- Prisma cannot express a WHERE clause on an index. Each of these backs a query
-- that runs on a hot path.
-- -----------------------------------------------------------------------------

-- The public catalog query: active, non-deleted products only.
CREATE INDEX IF NOT EXISTS "product_active_idx"
  ON "product" ("createdAt" DESC)
  WHERE "deletedAt" IS NULL AND "status" = 'ACTIVE';

-- Option-combination uniqueness per product. A jsonb equality index is the only
-- way to express "no two variants of one product share an option set".
CREATE UNIQUE INDEX IF NOT EXISTS "product_variant_options_unique"
  ON "product_variant" ("productId", "options")
  WHERE "deletedAt" IS NULL;

-- Exactly ONE default address per (customer, type). Enforced here rather than by
-- an application "unset the others first", which races with a concurrent update.
CREATE UNIQUE INDEX IF NOT EXISTS "address_single_default"
  ON "address" ("customerId", "type")
  WHERE "isDefault" = true AND "deletedAt" IS NULL;

-- The reservation-expiry cron scans exactly this predicate.
CREATE INDEX IF NOT EXISTS "stock_reservation_pending_idx"
  ON "stock_reservation" ("expiresAt")
  WHERE "releasedAt" IS NULL;

-- The outbox dispatcher polls exactly this predicate; without a partial index it
-- degrades into a full scan as processed rows accumulate.
CREATE INDEX IF NOT EXISTS "outbox_pending_idx"
  ON "outbox_message" ("availableAt")
  WHERE "processedAt" IS NULL AND "deadAt" IS NULL;

-- -----------------------------------------------------------------------------
-- 4. APPEND-ONLY ENFORCEMENT
--
-- "An audit table the app can UPDATE is not an audit table."
--
-- Two layers, because either alone is insufficient:
--   (a) triggers, which stop even a superuser's careless UPDATE; and
--   (b) role grants below, which stop the application entirely.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted. Correct a bad entry by appending a compensating one.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "audit_log_append_only" ON "audit_log";
CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

DROP TRIGGER IF EXISTS "inventory_ledger_append_only" ON "inventory_ledger";
CREATE TRIGGER "inventory_ledger_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_ledger"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- -----------------------------------------------------------------------------
-- 5. RUNTIME ROLE GRANTS
--
-- Migrations run as the OWNER role; the application connects as `akai_app`.
-- Separating them is what makes the append-only guarantee real: the runtime role
-- simply has no UPDATE or DELETE privilege on the two ledger tables, so even a
-- SQL-injection foothold in the app cannot rewrite history.
--
-- Guarded with a DO block so a local dev database that has not provisioned the
-- role still migrates cleanly. Provisioning `akai_app` is a documented
-- production deploy prerequisite.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akai_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO akai_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO akai_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO akai_app';

    -- Then take the mutating privileges back on the append-only tables.
    EXECUTE 'REVOKE UPDATE, DELETE ON "audit_log" FROM akai_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON "inventory_ledger" FROM akai_app';

    -- Provider webhook dedupe is insert-only too: deleting a processed event id
    -- would let a replayed webhook re-apply a state change. TagadaPay's CRM
    -- plane signs no timestamp, so this table is the ONLY unconditional replay
    -- defence — the revoke below is what makes it one-way.
    EXECUTE 'REVOKE UPDATE, DELETE ON "provider_event" FROM akai_app';
  ELSE
    RAISE NOTICE
      'Role akai_app not found; skipping runtime grants. Production MUST provision it — the append-only guarantee depends on the app not owning these tables.';
  END IF;
END
$$;
