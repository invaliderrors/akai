-- =============================================================================
-- First-boot provisioning for the local Postgres container.
--
-- Postgres runs everything in /docker-entrypoint-initdb.d exactly once, against
-- an EMPTY data directory. Editing this file has no effect on an existing
-- volume — run `docker compose down -v` first.
--
-- This is the LOCAL mirror of what a production deploy must provision by hand.
-- Keeping them in step matters: the append-only guarantee on the audit and
-- inventory ledgers is a GRANT, not application logic, so a developer whose
-- database lacks the `akai_app` role is running without the control that
-- production relies on and cannot discover a violation of it locally.
-- =============================================================================

-- Case-insensitive email addresses. `customer.email` is citext so that
-- Alice@example.com and alice@example.com cannot become two accounts — the
-- registration path treats them as the same person, and only the database can
-- make the unique index agree.
CREATE EXTENSION IF NOT EXISTS citext;

-- The RUNTIME role. Migrations run as the owner (`akai`); the application
-- connects as this one. The split is what makes "the app cannot rewrite the
-- audit log" a fact about privileges rather than a promise about code.
--
-- The migration in libs/db/prisma/migrations/20260720000100_* detects this role
-- and applies the grants — including REVOKE UPDATE, DELETE on the append-only
-- tables. It skips silently when the role is absent, which is why creating it
-- here matters: without it, local runs quietly get a permission model that
-- production does not have.
DO
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akai_app') THEN
    CREATE ROLE akai_app WITH LOGIN PASSWORD 'akai_app';
  END IF;
END
$$;
