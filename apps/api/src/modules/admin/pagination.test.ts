import { describe, expect, it, vi } from "vitest";
import { paginateCursor } from "./pagination";

interface Row {
  readonly id: string;
}

const rows = (count: number, offset = 0): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `id-${index + offset}` }));

describe("paginateCursor", () => {
  it("over-fetches by exactly one to detect a further page", async () => {
    const fetch = vi.fn(async () => rows(11));

    await paginateCursor({ cursor: null, limit: 10 }, (row) => row.id, fetch);

    // take = limit + 1. A second COUNT query instead would cost a scan and could
    // disagree with the page just read if a write landed between the two.
    expect(fetch).toHaveBeenCalledWith({ take: 11, cursor: null });
  });

  it("never returns the sentinel row it fetched to detect the next page", async () => {
    const page = await paginateCursor(
      { cursor: null, limit: 10 },
      (row) => row.id,
      async () => rows(11),
    );

    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    // The cursor is the last RETURNED row, not the sentinel — otherwise the next
    // page would silently skip one record.
    expect(page.nextCursor).toBe("id-9");
  });

  it("reports the final page as complete", async () => {
    const page = await paginateCursor(
      { cursor: null, limit: 10 },
      (row) => row.id,
      async () => rows(10),
    );

    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(false);
    // Null, not the last id: a non-null cursor here would make the client fetch
    // one more page and get an empty result, which most UIs render as a flicker.
    expect(page.nextCursor).toBeNull();
  });

  it("handles an empty result without inventing a cursor", async () => {
    const page = await paginateCursor<Row>(
      { cursor: null, limit: 10 },
      (row) => row.id,
      async () => [],
    );

    expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it("passes the incoming cursor through to the fetcher", async () => {
    const fetch = vi.fn(async () => rows(3));

    await paginateCursor({ cursor: "id-42", limit: 5 }, (row) => row.id, fetch);

    expect(fetch).toHaveBeenCalledWith({ take: 6, cursor: "id-42" });
  });

  it("rejects a non-positive or non-integer limit rather than issuing the query", async () => {
    const fetch = vi.fn(async () => rows(1));

    // A limit of 0 becomes `take: 1` and silently returns a one-row page; a
    // negative one reverses direction in Prisma. Both are better caught here.
    for (const limit of [0, -1, 2.5, Number.NaN]) {
      await expect(
        paginateCursor({ cursor: null, limit }, (row: Row) => row.id, fetch),
      ).rejects.toThrow(RangeError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
