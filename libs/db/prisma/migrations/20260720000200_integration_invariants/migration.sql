-- =============================================================================
-- Integration pass: invariants the domain modules assume but the schema did not
-- yet enforce, plus the one column TOTP replay defence requires.
--
-- Each item here was raised by a module author who could not fix it themselves
-- because the schema belongs to libs/db. They are grouped into one migration
-- because they land together; none depends on another.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Exactly one default address per (customer, type).
--
-- AddressesService enforces this inside a transaction: it clears the existing
-- default before setting a new one. That is correct under serial execution and
-- WRONG under concurrency — two simultaneous "create as default" requests can
-- both read "no conflicting default", both clear nothing, and both insert. The
-- customer then has two default shipping addresses and checkout picks
-- arbitrarily between them.
--
-- Prisma's `@@unique` cannot express a WHERE clause, so this is raw SQL. It is
-- PARTIAL on two conditions:
--   * `is_default` — non-default rows are unconstrained, and there are many.
--   * `deleted_at IS NULL` — addresses are soft-deleted, and a deleted default
--     must not block a new one. Without this clause, deleting and re-adding a
--     default address would fail with a unique violation.
-- -----------------------------------------------------------------------------

-- Collapse any pre-existing duplicates before the index is built, otherwise
-- CREATE UNIQUE INDEX fails on an existing database. Keeps the most recently
-- updated row as the default, which is the least surprising choice.
UPDATE "address" a
SET "isDefault" = false
WHERE a."isDefault"
  AND a."deletedAt" IS NULL
  AND a."id" <> (
    SELECT b."id"
    FROM "address" b
    WHERE b."customerId" = a."customerId"
      AND b."type" = a."type"
      AND b."isDefault"
      AND b."deletedAt" IS NULL
    ORDER BY b."updatedAt" DESC, b."id" DESC
    LIMIT 1
  );

CREATE UNIQUE INDEX "address_one_default_per_type"
  ON "address" ("customerId", "type")
  WHERE "isDefault" AND "deletedAt" IS NULL;


-- -----------------------------------------------------------------------------
-- 2. TOTP replay defence.
--
-- A TOTP code stays valid for its time step plus the accepted drift window —
-- about 90 seconds. Nothing recorded which counter had already been spent, so
-- the same six digits were accepted repeatedly within that window. A code
-- captured over the shoulder, phished in real time, or read out of a proxy log
-- could therefore be replayed by a second party.
--
-- BIGINT, not INT: the counter is unix-time/30, which is ~5.8e7 today and grows
-- forever. INT would be fine for centuries, but a counter column that can ever
-- overflow is not worth the four bytes saved.
--
-- Nullable: an account that has never completed a TOTP challenge has no spent
-- counter, and 0 would be a lie that happens to work.
-- -----------------------------------------------------------------------------

ALTER TABLE "customer" ADD COLUMN "lastTotpCounter" BIGINT;


-- -----------------------------------------------------------------------------
-- 3. Grants for the new index/column are inherited from the table, so there is
--    nothing to re-run from the previous migration's DO block. Noted explicitly
--    because "did I need to re-grant?" is the first question on reading this.
-- -----------------------------------------------------------------------------
