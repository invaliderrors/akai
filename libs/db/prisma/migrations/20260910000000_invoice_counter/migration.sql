-- =============================================================================
-- A GENUINELY GAP-FREE INVOICE COUNTER.
--
-- `20260720000100_invariants_sequences_grants` states the rule in its own words:
-- "INVOICE numbers may NOT have gaps — that is a legal requirement in most EU
-- member states". It then implements it with `nextval`, WHICH CANNOT KEEP THAT
-- PROMISE. A Postgres sequence is deliberately non-transactional so that
-- concurrent sessions never block on each other; the price is that a number it
-- hands out is gone whether or not the transaction that drew it commits.
--
-- Measured on postgres:16-alpine against this very schema:
--
--   BEGIN;
--     UPDATE "order" SET "invoiceNumber" = next_invoice_number()
--       WHERE "id" = … AND "invoiceNumber" IS NULL;
--   ROLLBACK;
--   -- row still NULL, and invoice_number_seq.last_value moved 1 -> 2.
--
-- and, with two overlapping sessions on ONE null row: the winner took
-- INV-2026-000003, the loser printed `UPDATE 0`, and last_value moved 2 -> 4.
-- The target-list `nextval` is evaluated BEFORE the tuple lock is taken; when
-- EvalPlanQual then re-checks `"invoiceNumber" IS NULL` and finds it no longer
-- holds, the already-consumed number is simply discarded. So the two ordinary,
-- expected events on a payments plane — a settlement that rolls back, and two
-- of a provider's retried deliveries racing — each punch a permanent hole in a
-- series the law requires to be unbroken.
--
-- WHAT THE LIVE PATH ACTUALLY DID BEFORE THIS CHANGE — read this before sizing
-- any backfill. The transcript above is a property of `nextval`, demonstrated
-- against this schema; it is NOT a description of settlements that happened.
-- `next_invoice_number()` had exactly one caller, `OrdersService.markPaid`,
-- which has no production caller, so the live settlement path allocated NOTHING
-- and every paid order carried a NULL `invoiceNumber`. The visible symptom was
-- the `payment-receipt` email deferring forever ("Invoice number not yet
-- allocated") until its outbox row dead-lettered, so no customer ever received
-- a receipt. A backfill therefore covers EVERY order ever paid, not merely the
-- ones a gap would have skipped.
--
-- THE FIX IS A ROW, NOT A SEQUENCE. An ordinary table row updated under its own
-- lock is MVCC state like any other: it rolls back with its transaction, and a
-- second transaction that wants it waits. That is precisely the blocking a
-- sequence exists to avoid — and precisely what a legal invariant requires.
-- Invoice allocation happens at most once per order, only on the PAID
-- transition, so contention on one row is measured in settlements per second
-- and is not a throughput concern this platform has.
--
-- EXPAND, DO NOT CONTRACT. `invoice_number_seq` and `next_invoice_number()` are
-- left in place and untouched, so the currently-deployed application keeps
-- running unchanged against this schema and a rollback of the app is a
-- non-event. They are commented as deprecated rather than dropped; a later,
-- separate migration may remove them once nothing calls them.
-- (`OrdersService.markPaid` still does — see that file.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. THE COUNTER
--
-- One row, forever. `id` is a boolean pinned to true by a CHECK: it makes the
-- primary key double as the singleton constraint, so a second counter row is
-- not a thing that can exist — and two counters would mean two orders getting
-- the same invoice number, which is the failure this table exists to prevent.
--
-- BIGINT to match the sequence it replaces. `lastNumber` is the number most
-- recently ISSUED, so allocation is `+ 1 … RETURNING` and an untouched counter
-- reads 0.
-- -----------------------------------------------------------------------------

CREATE TABLE "invoice_counter" (
    "id"         BOOLEAN NOT NULL DEFAULT true,
    "lastNumber" BIGINT  NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_counter_pkey"      PRIMARY KEY ("id"),
    CONSTRAINT "invoice_counter_singleton" CHECK ("id" = true),
    CONSTRAINT "invoice_counter_positive"  CHECK ("lastNumber" >= 0)
);

COMMENT ON TABLE "invoice_counter" IS
  'Singleton, transactional invoice-number counter. Never DELETE the row: numbering would restart at 1 and re-issue numbers that are already on filed invoices.';

-- -----------------------------------------------------------------------------
-- 2. SEEDING — THE SHARPEST HAZARD IN THIS FILE
--
-- A counter that starts at 0 while numbers have already been issued re-issues
-- them, and `order.invoiceNumber` is UNIQUE, so the first duplicate does not
-- corrupt anything quietly — it fails a customer's settlement transaction, in
-- production, on the money path. The starting point is therefore DERIVED, here,
-- in SQL, from both places a number may already be recorded:
--
--   a. the old sequence's position — it may have been advanced by an allocation
--      that rolled back, so it can legitimately be AHEAD of every stored number,
--      and that is exactly the pre-existing gap we must not walk back into;
--   b. the highest number actually present on an order row — it may be ahead of
--      the sequence if numbers were ever imported or backfilled.
--
-- GREATEST of the two, so neither source can be missed. `pg_sequence_last_value`
-- returns NULL for a sequence that has never been called, which is why both
-- terms are COALESCEd to 0 — a fresh database seeds to 0 and issues 000001.
--
-- The regexp guard on (b) is not decoration: `invoiceNumber` is free text as far
-- as Postgres is concerned, and one non-conforming row would abort this
-- migration on an invalid bigint cast.
-- -----------------------------------------------------------------------------

INSERT INTO "invoice_counter" ("id", "lastNumber")
SELECT
  true,
  GREATEST(
    COALESCE(pg_sequence_last_value('invoice_number_seq'::regclass), 0),
    COALESCE(
      (
        SELECT MAX((substring("invoiceNumber" from '([0-9]+)$'))::bigint)
        FROM "order"
        WHERE "invoiceNumber" ~ '^INV-[0-9]{4}-[0-9]+$'
      ),
      0
    )
  )
ON CONFLICT ("id") DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. ALLOCATION
--
-- INSERT … ON CONFLICT DO UPDATE rather than a bare UPDATE, for one reason that
-- matters operationally: it is SELF-SEEDING. The counter row is ordinary data,
-- so anything that empties the table — a TRUNCATE, a restore from a dump taken
-- before this migration, the integration harness resetting between tests —
-- would otherwise turn every subsequent settlement into a silent no-op that
-- leaves a PAID order with no invoice number. The conflict path takes the same
-- exclusive row lock a plain UPDATE would, so the concurrency guarantee is
-- identical.
--
-- The FORMAT IS PRESERVED EXACTLY: `INV-YYYY-NNNNNN`, the year from the
-- allocation date, from a counter that never resets — the behaviour
-- `next_invoice_number()` established and which invoices already in customers'
-- hands were issued under. A per-year reset would be defensible in the
-- abstract, but changing it here would mean this year's numbering restarting
-- mid-year and colliding with numbers already filed.
--
-- RETURNING on the conflict path yields the POST-update row, so the expression
-- below reads the number this call just took.
--
-- NEVER CALL THIS IN THE TARGET LIST OF A CONDITIONAL UPDATE. It is
-- transactional, so it cannot leak a number the way `nextval` does — but a
-- statement whose WHERE clause fails to match would still have bumped the
-- counter, and the caller would have to roll back to undo it. The application
-- calls it only after it has confirmed, under the order's row lock, that a
-- number is actually needed.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION allocate_invoice_number() RETURNS text AS $$
  INSERT INTO "invoice_counter" ("id", "lastNumber")
  VALUES (
    true,
    -- NEVER a literal 1. If the row is absent — a restore from a dump taken
    -- before this migration, a reset run against a database that still holds
    -- orders — seeding at 1 re-issues numbers that are already on filed
    -- invoices. Silently: the duplicates are legal corruption long before the
    -- UNIQUE on "order"."invoiceNumber" finally aborts some later customer's
    -- settlement on the money path. Deriving the floor from what has actually
    -- been issued, exactly as this migration's own seed does, means a re-seed
    -- can only ever move FORWARD.
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
-- 4. THE SUPERSEDED MECHANISM, MARKED BUT NOT REMOVED
--
-- Left callable so the previously-deployed application still runs against this
-- schema. Commented so the next person to reach for it reads why not first.
-- -----------------------------------------------------------------------------

COMMENT ON FUNCTION next_invoice_number() IS
  'DEPRECATED — NOT TRANSACTIONAL. nextval is not rolled back, so a settlement that aborts burns a number permanently. Use allocate_invoice_number(). Kept only so a rollback of the application still runs.';

COMMENT ON SEQUENCE "invoice_number_seq" IS
  'DEPRECATED — superseded by "invoice_counter". Retained for rollback compatibility; its position was folded into the counter''s seed value.';

-- -----------------------------------------------------------------------------
-- 5. RUNTIME ROLE GRANTS
--
-- GRANTS ARE NOT INHERITED. The blanket `GRANT … ON ALL TABLES` in
-- 20260720000100 applied to the tables that existed at that moment; a table
-- created afterwards has none of it, and the failure mode is a permission error
-- at runtime on the settlement path that no test running as the owner would
-- ever see.
--
-- SELECT, INSERT and UPDATE — and deliberately NOT DELETE. Removing the counter
-- row would restart numbering at 1 and re-issue numbers that are already on
-- filed invoices; nothing in the application ever needs to, so the role simply
-- cannot. (The append-only tables get the same treatment for the same reason,
-- one migration earlier.)
--
-- Guarded with a DO block so a local dev database that has not provisioned the
-- role still migrates cleanly.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akai_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "invoice_counter" TO akai_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION allocate_invoice_number() TO akai_app';
  ELSE
    RAISE NOTICE
      'Role akai_app not found; skipping invoice_counter grants. Production MUST provision it — without these grants every settlement fails to allocate an invoice number.';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- REVERT — run this WITH the application rollback, not instead of it.
--
-- The schema change is additive, so old code runs against it unchanged. What
-- does NOT hold is the numbering: from the moment this migration lands the
-- counter advances and `invoice_number_seq` does not, so old code redeployed
-- later resumes from the frozen sequence and re-issues numbers the counter has
-- already handed out. `order"."invoiceNumber` is UNIQUE, so the first repeat
-- aborts a customer's settlement rather than corrupting quietly — but it aborts
-- it on the money path.
--
-- Re-point the sequence at the counter's high-water mark first. The three-arg
-- form is required: a bare setval(seq, 0) ERRORS ("value 0 is out of bounds"),
-- which is the state every database that has never issued a number is in — a
-- new environment, staging, or production before its first sale.
--
--   SELECT setval(
--     'invoice_number_seq',
--     GREATEST((SELECT "lastNumber" FROM "invoice_counter"), 1),
--     (SELECT "lastNumber" FROM "invoice_counter") > 0
--   );
--
-- Old code then continues the series without repeating a number. It reacquires
-- the gap-on-rollback defect this migration exists to remove; that is the price
-- of the rollback and it is why contraction is a separate, later change.
-- -----------------------------------------------------------------------------
