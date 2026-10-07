import { expect, test } from "@playwright/test";

/**
 * The auth shell's end-to-end contract.
 *
 * These assertions cover what unit tests structurally cannot: that a real page
 * renders through next-intl's request config with the Spanish catalogue, and
 * that middleware's redirects and cookies behave in a real browser.
 *
 * REQUIRES `apps/dashboard/.env.local` (copy `.env.local.example`). Without
 * SESSION_SECRET the app fails fast on the first request by design, and these
 * tests will report that rather than a routing failure.
 */

test.describe("route protection", () => {
  test("sends an anonymous visitor from the dashboard root to sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in\?next=%2F$/);
  });

  test("preserves the requested destination through the redirect", async ({ page }) => {
    await page.goto("/orders");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Forders$/);
  });

  test("sends a former English URL to the Spanish page", async ({ page }) => {
    // The dashboard is Spanish only; old `/en/...` links 301 to the bare path.
    await page.goto("/en/admin/products");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fadmin%2Fproducts$/);
  });
});

test.describe("auth shell", () => {
  test("renders Spanish copy", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { name: "Entra en tu cuenta" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "es-CO");
  });

  test("reaches sign-up and forgot-password from sign-in", async ({ page }) => {
    await page.goto("/sign-in");

    await page.getByRole("link", { name: "Crear cuenta" }).click();
    await expect(page).toHaveURL(/\/sign-up$/);

    await page.goto("/sign-in");
    await page.getByRole("link", { name: "¿Has olvidado tu contraseña?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });
});

test.describe("CSRF", () => {
  test("seeds a readable CSRF cookie on the first request", async ({ page, context }) => {
    // The very first visitor has no cookies at all. If middleware did not seed
    // one here, their first sign-in attempt would be rejected with a 403.
    await page.goto("/sign-in");

    const csrf = (await context.cookies()).find((cookie) => cookie.name === "akai_csrf");
    expect(csrf?.value).toBeTruthy();
    // Must be script-readable — the double-submit mechanism depends on it.
    expect(csrf?.httpOnly).toBe(false);
  });

  test("rejects a BFF post with no CSRF header", async ({ request }) => {
    const response = await request.post("/api/auth/login", {
      data: { email: "nobody@example.com", password: "irrelevant" },
    });

    expect(response.status()).toBe(403);
  });
});
