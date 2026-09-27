import type { Paginated } from "@akai/contracts";

/**
 * Cursor pagination runtime helper.
 *
 * @akai/contracts supplies the SCHEMAS (`paginationQuerySchema`,
 * `paginatedSchema`) but no execution helper, so every list endpoint would
 * otherwise hand-roll the take+1 dance. Hand-rolling it is how one endpoint ends
 * up returning `hasMore: true` on the final page, or leaks the sentinel row it
 * fetched only to detect a next page.
 *
 * The over-fetch is deliberate: asking for `limit + 1` rows and discarding the
 * extra is the only way to know whether a further page exists WITHOUT a second
 * COUNT query, which on a large table costs a full scan and — worse — can
 * disagree with the page you just read if a write lands between the two.
 *
 * NOTE: this belongs in a shared location once one exists (see followUps).
 */

export interface CursorPageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

/** Fetches AT MOST `take` rows, starting strictly after `cursor`. */
export type CursorPageFetcher<T> = (args: {
  readonly take: number;
  readonly cursor: string | null;
}) => Promise<readonly T[]>;

export async function paginateCursor<T>(
  request: CursorPageRequest,
  selectCursor: (item: T) => string,
  fetch: CursorPageFetcher<T>,
): Promise<Paginated<T>> {
  if (!Number.isInteger(request.limit) || request.limit < 1) {
    throw new RangeError(`limit must be a positive integer, received ${request.limit}`);
  }

  const rows = await fetch({ take: request.limit + 1, cursor: request.cursor });

  const hasMore = rows.length > request.limit;
  // Drop the sentinel. Returning it would hand the client one more row than it
  // asked for and desynchronise the next cursor.
  const items = hasMore ? rows.slice(0, request.limit) : [...rows];

  const last = items.at(-1);

  return {
    items,
    // Null when there is no further page, so "end of list" is an explicit fact
    // rather than a cursor that returns an empty page on the next round trip.
    nextCursor: hasMore && last !== undefined ? selectCursor(last) : null,
    hasMore,
  };
}
