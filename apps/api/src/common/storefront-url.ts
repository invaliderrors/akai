/**
 * An absolute storefront URL, query-encoded.
 *
 * The API links back to the storefront in two places that cannot afford a
 * malformed URL: the Wompi `redirect-url` a paying customer returns through,
 * and links in emails. The storefront is Spanish only and serves every page at
 * its bare path (`/checkout/processing`), so the URL is origin + path + query.
 *
 * `query` goes through `URLSearchParams`, so an order number containing a
 * character that means something in a query string cannot break out of its
 * parameter — the reason this is not a template literal at the call site.
 */
export function storefrontUrl(
  origin: string,
  pathname: string,
  query: Readonly<Record<string, string>> = {},
): string {
  // A trailing slash on the configured origin would otherwise produce a double
  // slash, which some proxies normalise and some serve as a distinct path.
  const base = origin.replace(/\/+$/, "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const url = new URL(`${base}${path}`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}
