/**
 * @akai/i18n
 *
 * Shared locale routing + locale-aware navigation re-exports.
 *
 * The routing RULE — which locales exist, which one is served unprefixed, and
 * what a locale-correct storefront URL therefore looks like — lives here so the
 * storefront and the API cannot disagree about it. next-intl itself is
 * deliberately NOT imported: the API has no business loading a React router, so
 * this lib stays a set of pure values that `defineRouting` is fed on the web
 * side and that the API composes URLs from on the server side.
 */
export const LIB_NAME = "@akai/i18n" as const;

export * from "./lib/locale-routing";
