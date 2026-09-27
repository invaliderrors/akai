import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src",
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_DASHBOARD_BASE_URL ?? "http://localhost:3003",
    trace: "retain-on-failure",
    /**
     * Force Spanish, mirroring apps/storefront-e2e/playwright.config.ts.
     *
     * next-intl negotiates the locale from Accept-Language, and Chromium sends
     * `en-US`. Without this pin the DEFAULT-locale routes serve English, so a
     * test asserting Spanish copy at `/sign-in` fails while the application is
     * behaving exactly as designed — and, worse, a genuine regression in the
     * Spanish catalogue would be invisible because nothing ever requests it.
     */
    locale: "es-ES",
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
