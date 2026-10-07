// @ts-check
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

/**
 * Server-rendered on every request (`output: "server"`): prices, stock and the
 * visitor's session are per-request facts, and the API is the source of truth
 * for all of them. The shop is Spanish only: no Astro i18n config, every page
 * at its bare path; `src/middleware.ts` 301s the old `/en/...` URLs.
 */
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  server: { port: 3100 },
  vite: {
    plugins: [tailwindcss()],
    // Dependencies live in the workspace root, not in this app's package.json,
    // so Vite would externalise the React renderer — which imports the
    // `astro:react:opts` virtual module and cannot run unbundled.
    ssr: { noExternal: ["@astrojs/react"] },
  },
});
