import { defineMiddleware } from "astro:middleware";

import { legacyLocaleRedirect } from "@/lib/legacy-locale";

/**
 * The shop is Spanish only and every page lives at its bare path. The one job
 * left here is to 301 the old `/en/...` (and `/es/...`) URLs to that path.
 */
export const onRequest = defineMiddleware((context, next) => {
  const target = legacyLocaleRedirect(context.url.pathname, context.url.search);
  return target === null ? next() : context.redirect(target, 301);
});
