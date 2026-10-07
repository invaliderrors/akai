import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
import path from "node:path";

const workspaceRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  plugins: [
    // Vitest transforms with esbuild, which does NOT emit decorator metadata.
    // Nest constructor injection reads `design:paramtypes` from that metadata,
    // so without this plugin every provider test fails at resolution time.
    // See apps/api/src/nest-di.test.ts, which exists to prove this works.
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
    // `node`, never jsdom — and note there is deliberately NO workspace-global
    // setup file, so the storefront's jest-dom + NEXT_PUBLIC_API_URL stub can
    // never leak into the API's environment.
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
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
