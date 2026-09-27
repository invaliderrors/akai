import { isStorefrontLocale } from "@akai/i18n";
import { defineMiddleware } from "astro:middleware";

/**
 * Locale routing. Pages live once under `src/pages/[locale]/`; Spanish (the
 * default) is served WITHOUT a prefix by rewriting `/x` to `/es/x`, English
 * keeps its `/en` prefix, and a literal `/es/...` URL is redirected to its
 * canonical unprefixed form so no page has two addresses.
 */
const PASSTHROUGH = /^\/(api|_astro|_image|404|favicon\.svg|robots\.txt)(\/|$)/;

export const onRequest = defineMiddleware((context, next) => {
  const { pathname, search } = context.url;
  const first = pathname.split("/")[1] ?? "";
  // Set before anything else: rewrites keep `locals`, and pages outside
  // `[locale]` (the 404) still render the shared layout.
  context.locals.locale ??= "es";

  if (PASSTHROUGH.test(pathname)) return next();

  if (first === "es") {
    return context.redirect(`${pathname.slice(3) || "/"}${search}`, 301);
  }

  if (isStorefrontLocale(first)) {
    context.locals.locale = first;
    return next();
  }

  return next(`/es${pathname === "/" ? "" : pathname}${search}`);
});
