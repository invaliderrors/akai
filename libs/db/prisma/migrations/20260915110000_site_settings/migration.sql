-- THE FIRST DB-BACKED ADMIN SETTING THIS SCHEMA HAS EVER HAD.
--
-- §2 of `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`:
-- maintenance mode, toggleable by an admin WITHOUT a redeploy. That rules out
-- an env var — this deployment's own quirk means a `git push` deploys
-- nothing, so an env-var flag would need a manual redeploy to change, which
-- is exactly the friction an admin toggle exists to remove. The flag has to
-- live somewhere a running process reads at request time, and the only such
-- place this system has is Postgres.
--
-- ONE ROW, FOREVER — same shape as "invoice_counter"
-- (20260910000000_invoice_counter): `id` is a boolean pinned to true by a
-- CHECK, so the primary key doubles as the singleton guarantee and a second
-- settings row is not a thing that can exist.

CREATE TABLE "site_settings" (
    "id"              BOOLEAN     NOT NULL DEFAULT true,
    "maintenanceMode" BOOLEAN     NOT NULL DEFAULT false,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_settings_pkey"      PRIMARY KEY ("id"),
    CONSTRAINT "site_settings_singleton" CHECK ("id" = true)
);

COMMENT ON TABLE "site_settings" IS
  'Singleton row of admin-togglable, DB-backed settings — read at request time, not at boot. Never DELETE the row.';

-- SELF-SEEDING, same reasoning "invoice_counter"'s allocator gives for its own
-- ON CONFLICT DO UPDATE: if this table is ever found empty (a restore from a
-- dump taken before this migration, a reset between test runs), the API and
-- the admin write path must both still work rather than 500ing on a missing
-- row. Application code writes with the identical ON CONFLICT shape; this
-- INSERT just guarantees the row exists from the moment the migration lands.
INSERT INTO "site_settings" ("id", "maintenanceMode", "updatedAt")
VALUES (true, false, now())
ON CONFLICT ("id") DO NOTHING;

-- GRANTS ARE NOT INHERITED (see 20260910000000_invoice_counter §5) — a table
-- created after the blanket GRANT in 20260720000100 has none of it, and the
-- failure mode is a permission error on the admin toggle and on every
-- storefront request that polls this table, in production, the first time
-- either path runs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akai_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "site_settings" TO akai_app';
  ELSE
    RAISE NOTICE
      'Role akai_app not found; skipping site_settings grants. Production MUST provision it — without these grants the maintenance toggle and every storefront poll of it fail.';
  END IF;
END
$$;
