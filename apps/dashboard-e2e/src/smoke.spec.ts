import { expect, test } from "@playwright/test";

test("dashboard shell responds", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBeLessThan(400);
});
