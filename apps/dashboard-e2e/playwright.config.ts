import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src",
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_DASHBOARD_BASE_URL ?? "http://localhost:3003",
    trace: "retain-on-failure",
    /** The shop's own locale; the dashboard serves Spanish whatever the browser asks for. */
    locale: "es-CO",
  },
  webServer: process.env.E2E_DASHBOARD_BASE_URL
    ? undefined
    : {
        command: "pnpm nx run dashboard:dev --port=3003",
        url: "http://localhost:3003",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
