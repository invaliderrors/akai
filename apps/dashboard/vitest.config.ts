import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

const workspaceRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**"],
    server: {
      deps: {
        // Preserved verbatim from the storefront config: next-intl's ESM
        // imports next/navigation's CJS shim, and dropping this reintroduces
        // a "Cannot find module" resolution failure.
        inline: ["next-intl"],
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@akai/contracts": path.resolve(workspaceRoot, "libs/contracts/src/index.ts"),
      "@akai/money": path.resolve(workspaceRoot, "libs/money/src/index.ts"),
      "@akai/rich-text": path.resolve(workspaceRoot, "libs/rich-text/src/index.ts"),
      "@akai/config": path.resolve(workspaceRoot, "libs/config/src/index.ts"),
      "@akai/i18n": path.resolve(workspaceRoot, "libs/i18n/src/index.ts"),
      "@akai/session": path.resolve(workspaceRoot, "libs/session/src/index.ts"),
      "@akai/ui": path.resolve(workspaceRoot, "libs/ui/src/index.ts"),
      "@akai/testing": path.resolve(workspaceRoot, "libs/testing/src/index.ts"),
    },
  },
});
