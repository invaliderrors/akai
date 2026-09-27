import type { Locale } from "@akai/contracts";
import { DEFAULT_STOREFRONT_LOCALE, localePathname } from "@akai/i18n";

/**
 * Locale-aware links. Spanish lives at `/`, English at `/en` — the same rule
 * the API uses to build checkout return URLs (`storefrontUrl` in @akai/i18n),
 * so both sides always agree on where a page is.
 */
export function href(locale: Locale, pathname: string): string {
  return localePathname(locale, pathname);
}

/** The same page in the other locale, for the language switch. */
export function alternatePath(pathname: string, from: Locale, to: Locale): string {
  const bare =
    from === DEFAULT_STOREFRONT_LOCALE ? pathname : pathname.replace(new RegExp(`^/${from}(?=/|$)`), "") || "/";
  return localePathname(to, bare);
}
