/**
 * The shop used to be bilingual: Spanish at `/x`, English at `/en/x`, and a
 * literal `/es/x` redirected to `/x`. It is Spanish only now and every page
 * lives at its bare path, but `/en/...` links survive in bookmarks, search
 * results and old emails. They get a permanent redirect to the same page
 * rather than a 404.
 *
 * Returns the target (path + query) for a legacy-prefixed URL, or `null` when
 * the URL is not one. Only a WHOLE first segment counts: `/enamel` is a page,
 * not `/en` + `amel`.
 */
const LEGACY_PREFIX = /^\/(?:en|es)(?=\/|$)/;

export function legacyLocaleRedirect(pathname: string, search: string): string | null {
  if (!LEGACY_PREFIX.test(pathname)) return null;
  const bare = pathname.replace(LEGACY_PREFIX, "") || "/";
  return `${bare}${search}`;
}
