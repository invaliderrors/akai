import { defineConfig } from "vitest/config";
import path from "node:path";

const workspaceRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
  resolve: {
    alias: {
      // Vitest does not read tsconfig `paths`; this must mirror tsconfig.base.json.
      "@akai/contracts": path.resolve(workspaceRoot, "libs/contracts/src/index.ts"),
    },
  },
});
