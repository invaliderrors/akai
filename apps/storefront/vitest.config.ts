import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const lib = (name: string): string =>
  fileURLToPath(new URL(`../../libs/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@/": fileURLToPath(new URL("./src/", import.meta.url)),
      "@akai/contracts": lib("contracts"),
      "@akai/money": lib("money"),
      "@akai/rich-text": lib("rich-text"),
      "@akai/i18n": lib("i18n"),
      "@akai/session": lib("session"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
