import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  CursorPagination,
  activeCursor,
  clearCursors,
  cursorStack,
  popCursor,
  pushCursor,
  type PaginationLabels,
} from "./pagination";

/**
 * The locale-aware Link needs a routing context a unit test never has, so it is
 * mocked down to the anchor it renders. The href it is GIVEN is what matters
 * here; the locale prefix next-intl adds is covered by the e2e locale smoke.
 */
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    className,
    "aria-label": ariaLabel,
    "aria-current": ariaCurrent,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
    "aria-label"?: string;
    "aria-current"?: "true";
  }) => (
    <a href={href} className={className} aria-label={ariaLabel} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
}));

const LABELS: PaginationLabels = {
  nav: "Paginación",
  first: "Primera página",
  previous: "Anterior",
  next: "Siguiente",
  page: (page) => `Página ${page}`,
  perPage: "Por página",
  showing: ({ from, to, hasMore }) =>
    hasMore ? `Mostrando ${from}–${to} · hay más` : `Mostrando ${from}–${to}`,
};

const PATHNAME = "/admin/orders";

function renderPagination(props: Partial<Parameters<typeof CursorPagination>[0]> = {}) {
  return render(
    <CursorPagination
      labels={LABELS}
      pathname={PATHNAME}
      itemCount={25}
      pageSize={25}
      hasMore
      nextCursor="c3"
      {...props}
    />,
  );
}

describe("<CursorPagination />", () => {
  it("names the back/forward group", () => {
    renderPagination();
    expect(screen.getByRole("navigation", { name: "Paginación" })).toBeInTheDocument();
  });

  it("disables first and previous on the first page, without an href", () => {
    renderPagination();

    for (const name of ["Primera página", "Anterior"]) {
      const step = screen.getByRole("link", { name });
      // No href at all — the slot keeps its geometry and its name, and nothing
      // an operator clicks can navigate them to a page that does not exist.
      expect(step).not.toHaveAttribute("href");
      expect(step).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("enables first and previous once the stack has depth", () => {
    renderPagination({ searchParams: { cursor: ["a", "b"] } });

    // "First" empties the stack; "previous" pops exactly one level.
    expect(screen.getByRole("link", { name: "Primera página" })).toHaveAttribute(
      "href",
      PATHNAME,
    );
    expect(screen.getByRole("link", { name: "Anterior" })).toHaveAttribute(
      "href",
      `${PATHNAME}?cursor=a`,
    );
  });

  it("omits next entirely when there is no page after this one", () => {
    renderPagination({ hasMore: false, nextCursor: null });
    expect(screen.queryByRole("link", { name: "Siguiente" })).not.toBeInTheDocument();
  });

  it("pushes the next cursor onto the stack it was given", () => {
    renderPagination({ searchParams: { status: "PAID", cursor: ["a"] }, nextCursor: "b" });

    expect(screen.getByRole("link", { name: "Siguiente" })).toHaveAttribute(
      "href",
      `${PATHNAME}?status=PAID&cursor=a&cursor=b`,
    );
  });

  it("labels the page by the depth of the stack, never by a total", () => {
    renderPagination({ searchParams: { cursor: ["a", "b"] } });
    expect(screen.getByText("Página 3")).toBeInTheDocument();
  });

  it("says only what it knows about the range", () => {
    renderPagination({ searchParams: { cursor: ["a", "b"] } });
    // 2 levels deep at 25 a page: rows 51..75, and there is more after them.
    // Never "de 400" — no endpoint in the platform can produce that number.
    expect(screen.getByText("Mostrando 51–75 · hay más")).toBeInTheDocument();

    renderPagination({ itemCount: 9, hasMore: false, nextCursor: null });
    expect(screen.getByText("Mostrando 1–9")).toBeInTheDocument();
  });

  it("drops the summary when the page is empty", () => {
    renderPagination({ itemCount: 0, hasMore: false, nextCursor: null });
    expect(screen.queryByText(/Mostrando/)).not.toBeInTheDocument();
  });

  it("clears the cursor stack when the page size changes", () => {
    renderPagination({
      searchParams: { cursor: ["a", "b"], limit: "25", status: "PAID" },
      pageSize: 25,
    });

    // A cursor is a position in a result set sliced at one page size, so it
    // cannot survive the change — every other filter must.
    expect(screen.getByRole("link", { name: "50" })).toHaveAttribute(
      "href",
      `${PATHNAME}?status=PAID&limit=50`,
    );
    expect(screen.getByRole("link", { name: "100" })).toHaveAttribute(
      "href",
      `${PATHNAME}?status=PAID&limit=100`,
    );
  });

  it("marks the page size in force", () => {
    renderPagination({ pageSize: 50 });

    const current = screen.getByRole("navigation", { name: "Por página" });
    expect(screen.getByRole("link", { name: "50", current: true })).toBeInTheDocument();
    expect(current).toContainElement(screen.getByRole("link", { name: "50" }));
    expect(screen.getByRole("link", { name: "25", current: false })).toBeInTheDocument();
  });
});

describe("cursor stack helpers", () => {
  it("reads a repeated param as a stack and a single one as depth 1", () => {
    expect(cursorStack(["a", "b"])).toEqual(["a", "b"]);
    expect(cursorStack("a")).toEqual(["a"]);
    expect(cursorStack(undefined)).toEqual([]);
    // `?cursor=` means "no cursor", not "a cursor nothing matches".
    expect(cursorStack("")).toEqual([]);
  });

  it("takes the LAST cursor as the active one", () => {
    // The trap this exists to close: the admin pages' `single()` helper returns
    // the FIRST element of a repeated param, which is forever page two.
    expect(activeCursor(["a", "b", "c"])).toBe("c");
    expect(activeCursor(undefined)).toBeUndefined();
  });

  it("pushes and pops symmetrically", () => {
    const pushed = pushCursor({
      pathname: PATHNAME,
      searchParams: { status: "PAID", cursor: ["a", "b"] },
      cursor: "c",
    });
    expect(pushed).toBe(`${PATHNAME}?status=PAID&cursor=a&cursor=b&cursor=c`);

    const popped = popCursor({
      pathname: PATHNAME,
      searchParams: { status: "PAID", cursor: ["a", "b", "c"] },
    });
    expect(popped).toBe(`${PATHNAME}?status=PAID&cursor=a&cursor=b`);
  });

  it("pops to a bare path at depth 1 and stays there at depth 0", () => {
    expect(popCursor({ pathname: PATHNAME, searchParams: { cursor: "a" } })).toBe(PATHNAME);
    expect(popCursor({ pathname: PATHNAME })).toBe(PATHNAME);
  });

  it("clears the whole stack while keeping every other filter", () => {
    expect(
      clearCursors({
        pathname: PATHNAME,
        searchParams: { status: "PAID", cursor: ["a", "b"], limit: "50" },
      }),
    ).toBe(`${PATHNAME}?status=PAID&limit=50`);
  });

  it("honours a caller's own cursor param name", () => {
    expect(
      pushCursor({ pathname: "/admin/jobs", searchParams: { after: "x" }, param: "after", cursor: "y" }),
    ).toBe("/admin/jobs?after=x&after=y");
  });
});
