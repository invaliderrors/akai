import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "./routing";
import { loadMessages } from "./messages";

/**
 * Per-request locale + message resolution.
 *
 * The catalog is loaded through `./messages`, which imports the JSON statically
 * and validates it. The previous inline
 * `` (await import(`../../messages/${locale}.json`)).default `` was invisible to
 * both tsc and eslint — the failure mode spec §16 R1 calls out, where typecheck
 * and lint stay green while every page 500s — and it evaluated to `any`, so the
 * whole catalog entered the app unchecked. Both halves are gone: a missing
 * `messages/` directory is now a build error, and a catalog that is not a
 * message tree throws on load rather than rendering keys at the customer.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return { locale, messages: loadMessages(locale) };
});
