-- =============================================================================
-- Cross-instance rate-limiter store (spec §5).
--
-- Postgres-backed, NOT Redis: pg-boss is already the one stateful service, so a
-- shared throttler counter belongs here too. This is what makes login /
-- registration throttling hold under horizontal scaling — an in-process Map is
-- per-replica and is bypassed the moment a second instance runs, which is the
-- deployment target for a "ready-to-deploy" platform.
--
-- One row per rate-limit key. The atomic increment lives in the application as a
-- single `INSERT ... ON CONFLICT DO UPDATE` with a CASE that resets the window
-- when it has lapsed; that statement is why the counter is correct across
-- concurrent requests on different instances.
-- =============================================================================

CREATE TABLE "rate_limit_counter" (
    "key" VARCHAR(200) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_counter_pkey" PRIMARY KEY ("key")
);

-- The expiry sweep (cron) deletes rows past their window in bulk; index the
-- column it filters on so the sweep does not seq-scan the whole table.
CREATE INDEX "rate_limit_counter_resetAt_idx" ON "rate_limit_counter" ("resetAt");

-- -----------------------------------------------------------------------------
-- Runtime role grants.
--
-- Unlike the append-only ledger tables, this is a MUTABLE counter: the runtime
-- role needs INSERT + UPDATE (increment / window reset) and DELETE (sweep), plus
-- SELECT. The grant applied in 20260720000100 covered only the tables that
-- existed then, so this table — created later — must be granted explicitly.
--
-- Guarded with a DO block so a local dev database that has not provisioned the
-- `akai_app` role still migrates cleanly.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akai_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit_counter" TO akai_app';
  ELSE
    RAISE NOTICE
      'Role akai_app not found; skipping rate_limit_counter grant. Production MUST provision it.';
  END IF;
END
$$;
