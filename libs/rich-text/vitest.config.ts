import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // `node`, not jsdom. The whole point of choosing sanitize-html over a
    // DOMPurify wrapper is that the policy runs with no DOM at all, so a test
    // that quietly supplied one would stop proving that.
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
