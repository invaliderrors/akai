-- =============================================================================
-- ONE TRANSACTIONAL EMAIL PER PARCEL, NOT PER ORDER.
--
-- `email_event` carried `UNIQUE ("orderId", "templateKey")`, whose docblock
-- calls it "THE idempotency guarantee: one send per (order, template)". That is
-- exactly right for an order confirmation and exactly wrong for a shipment:
-- `Shipment` exists precisely so an order can go out in more than one parcel,
-- and a second `shipping-confirmation` would be swallowed as a duplicate —
-- which the outbox handler counts as terminal SUCCESS, so the customer simply
-- never hears about parcel two and nothing anywhere records a failure.
--
-- WHY A NOT NULL SENTINEL AND NOT A NULLABLE COLUMN. The obvious shape is a
-- nullable "shipmentId" in the unique. It would silently destroy the guarantee
-- for every other template: in Postgres, NULLs are DISTINCT for uniqueness, so
-- two rows with a NULL scope do not conflict and an order confirmation could be
-- sent twice. `dedupeScope` is therefore NOT NULL with a '' default — every
-- existing row and every order-scoped send keeps precisely today's semantics,
-- because ("orderId","templateKey",'') is the old key by another name.
--
-- ROLLS BACK CLEANLY IN BOTH DIRECTIONS. The column has a default, so the
-- PREVIOUS application — which does not know the column exists — keeps
-- inserting rows that land on '' and remain governed by the old semantics. No
-- backfill, no forward-only step.
-- =============================================================================

ALTER TABLE "email_event"
  ADD COLUMN IF NOT EXISTS "dedupeScope" VARCHAR(64) NOT NULL DEFAULT '';

-- Prisma has emitted this as a unique INDEX in some versions and as a table
-- CONSTRAINT in others, so drop whichever exists rather than assuming.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'email_event_orderId_templateKey_key'
  ) THEN
    EXECUTE 'ALTER TABLE "email_event" DROP CONSTRAINT "email_event_orderId_templateKey_key"';
  ELSIF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'email_event_orderId_templateKey_key'
  ) THEN
    EXECUTE 'DROP INDEX "email_event_orderId_templateKey_key"';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "email_event_orderId_templateKey_dedupeScope_key"
  ON "email_event" ("orderId", "templateKey", "dedupeScope");

COMMENT ON COLUMN "email_event"."dedupeScope" IS
  'Widens the idempotency key beyond (order, template). Empty string = the whole order, which is the correct scope for every template that fires once per order. A shipment id scopes a per-parcel send. NOT NULL on purpose: NULLs are distinct for uniqueness in Postgres, so a nullable scope would let duplicates through for every other template.';
