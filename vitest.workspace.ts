/**
 * Convenience entry point for running every suite in one process
 * (`pnpm exec vitest run` from the workspace root).
 *
 * CI and `pnpm test` go through Nx instead (`nx run-many -t test`), which runs
 * each project with its own config and cwd. Both paths read the SAME per-project
 * vitest.config.ts files, so there is no second source of truth.
 *
 * There is deliberately no workspace-level `setupFiles` here: the dashboard's
 * jest-dom import lives in apps/dashboard/vitest.setup.ts and must never be
 * inherited by the API, which runs in a `node` environment.
 */
export default [
  "apps/dashboard/vitest.config.ts",
  "apps/api/vitest.config.ts",
  "apps/worker/vitest.config.ts",
  "libs/*/vitest.config.ts",
];
