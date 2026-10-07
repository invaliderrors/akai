import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
import path from "node:path";

const workspaceRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  // Same decorator-metadata requirement as apps/api: these suites boot real
  // Nest modules against a real Postgres.
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: ["node_modules/**"],
    // Integration suites bring up a Postgres container per suite.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
  // The same `@akai/*` aliases apps/api's vitest config declares. Vitest does
  // not read `tsconfig.base.json` paths, so without these the suites resolve
  // nothing and fail at import rather than at assertion.
  resolve: {
    alias: {
      "@akai/contracts": path.resolve(workspaceRoot, "libs/contracts/src/index.ts"),
      "@akai/db": path.resolve(workspaceRoot, "libs/db/src/index.ts"),
      "@akai/money": path.resolve(workspaceRoot, "libs/money/src/index.ts"),
      "@akai/rich-text": path.resolve(workspaceRoot, "libs/rich-text/src/index.ts"),
      "@akai/config": path.resolve(workspaceRoot, "libs/config/src/index.ts"),
      "@akai/email-templates": path.resolve(
        workspaceRoot,
        "libs/email-templates/src/index.ts",
      ),
      "@akai/testing": path.resolve(workspaceRoot, "libs/testing/src/index.ts"),
      "@akai/observability": path.resolve(
        workspaceRoot,
        "libs/observability/src/index.ts",
      ),
    },
  },
});
