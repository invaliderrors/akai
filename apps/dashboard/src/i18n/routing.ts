import { defineRouting } from "next-intl/routing";

/**
 * Locale routing — IDENTICAL to the storefront's (apps/storefront/src/i18n/routing.ts).
 *
 * Same locales, same Spanish default, same `as-needed` prefixing, so a customer
 * moving from the shop to their account keeps their language and the URL shape
 * they already learned. Duplicated rather than shared because `libs/i18n` is
 * still a shell; promoting this is listed in followUps.
 */
export const routing = defineRouting({
  locales: ["es", "en"],
  defaultLocale: "es",
  localePrefix: "as-needed",
});
