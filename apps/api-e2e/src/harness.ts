import { execFileSync } from "node:child_process";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@akai/db";

/**
 * Integration-test harness: a REAL Postgres per suite.
 *
 * Why a real database rather than a mocked Prisma client: every guarantee this
 * schema makes lives in Postgres, not in TypeScript. The CHECK constraints, the
 * append-only triggers, the unique index that makes email idempotent, the
 * conditional UPDATE that prevents oversell — a mocked client validates none of
 * them, and those are precisely the mechanisms worth testing.
 *
 * Requires Docker. Suites that call this are skipped automatically when Docker
 * is unavailable (see `describeIntegration`), so a laptop without Docker still
 * gets a green unit run rather than a wall of infrastructure errors.
 */

const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");
const SCHEMA_PATH = path.join(WORKSPACE_ROOT, "libs/db/prisma/schema.prisma");

/**
 * The Prisma CLI's own entrypoint, resolved from the installed package.
 *
 * `require.resolve` on the package.json rather than on `prisma` itself: the
 * package exposes a `bin`, not a require-able main, so resolving the manifest
 * and walking to its `bin` is the only way to get an absolute path without
 * hardcoding a node_modules layout that pnpm does not use.
 */
const PRISMA_CLI = path.join(
  path.dirname(require.resolve("prisma/package.json")),
  "build/index.js",
);

export interface TestDatabase {
  readonly prisma: PrismaClient;
  readonly databaseUrl: string;
  stop(): Promise<void>;
  /**
   * Truncate every table between tests.
   *
   * TRUNCATE rather than dropping and re-migrating: it is roughly two orders of
   * magnitude faster, and re-running migrations per test would dominate the
   * suite's runtime. `RESTART IDENTITY` also resets order_number_seq, so a test
   * asserting on AK-2026-000001 is not order-dependent.
   */
  reset(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:16-alpine",
  )
    .withDatabase("akai_test")
    .withUsername("akai")
    .withPassword("akai")
    .start();

  const databaseUrl = container.getConnectionUri();

  // `migrate deploy`, the SAME command CI and production run. Using `db push`
  // here would test a schema that no environment actually applies, and would
  // silently skip the companion migration carrying the CHECK constraints,
  // sequences and append-only triggers.
  //
  // Invoked as `node <prisma>/build/index.js` rather than through `npx`. Two
  // reasons, and the first is not a preference: since the fix for CVE-2024-27980
  // Node refuses to `execFileSync` a `.cmd`/`.bat` without `shell: true`, so
  // `npx.cmd` fails outright on Windows with a bare EINVAL. Re-adding
  // `shell: true` would fix that by handing the argument list to cmd.exe, which
  // then re-splits it — and `WORKSPACE_ROOT` is a path we do not control and may
  // contain spaces. Resolving the CLI's own entrypoint sidesteps both, and it
  // pins the prisma the workspace installed rather than whatever `npx` decides
  // to fetch.
  execFileSync(process.execPath, [PRISMA_CLI, "migrate", "deploy", "--schema", SCHEMA_PATH], {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DIRECT_DATABASE_URL: databaseUrl,
      CHECKPOINT_DISABLE: "1",
    },
    stdio: "inherit",
  });

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();

  return {
    prisma,
    databaseUrl,

    async reset(): Promise<void> {
      const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      `;

      if (tables.length === 0) return;

      const list = tables.map((row) => `"public"."${row.tablename}"`).join(", ");
      // CASCADE because the graph is heavily foreign-keyed; RESTART IDENTITY so
      // order and invoice numbers start from a known point in every test.
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
      );
    },

    async stop(): Promise<void> {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}

/**
 * True when Docker appears usable.
 *
 * Integration suites gate on this so a developer without Docker sees skipped
 * tests rather than failures they cannot act on. CI sets `CI=true` and provides
 * Docker, so the suites always run there — the escape hatch is for laptops, not
 * for the pipeline.
 */
export function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
