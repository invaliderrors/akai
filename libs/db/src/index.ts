/**
 * @akai/db — Prisma client, schema, migrations and ownership-scoped helpers.
 *
 * SERVER ONLY. Tagged `scope:server`, so a Next app importing this is an
 * `@nx/enforce-module-boundaries` lint ERROR, not a warning. That rule is the
 * only mechanical thing standing between the Prisma client (and therefore the
 * database URL) and a browser bundle.
 *
 * The schema lives at libs/db/prisma/schema.prisma and is the source of truth
 * for every table. Migrations are forward-only (`prisma migrate deploy` in CI);
 * never `db push` against anything but a local scratch database.
 */

export * from "./client";
export * from "./ownership";
