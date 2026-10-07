import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import type { OrderSummary } from "@akai/contracts";

import { CursorPagination, type PaginationLabels } from "@/components/ui/pagination";
import { buildOrderSummary } from "@/lib/account/fixtures";

import { OrderList } from "./order-list";
import esMessages from "../../../messages/es.json";

/**
 * WHAT CHANGED, AND WHY THIS FILE LOST HALF ITS TESTS.
 *
 * `OrderList` used to be a client component that appended pages behind a "load
 * more" button, so most of this file exercised a state machine: the injected
 * `onLoadMore` fetcher, the append-not-replace rule, the in-flight guard, and
 * the failure path that kept loaded rows on screen. None of that exists now —
 * the cursor lives in the URL and the component is a pure function of its rows.
 * Deleting those tests is not a loss of coverage; the behaviour they covered is
 * gone, and the pagination they were standing in for is `ui/pagination`'s own.
 *
 * ONE OLD ASSERTION IS KEPT DELIBERATELY: `queryByRole("table")` is null in the
 * empty state. It used to pass by accident, because the old list was never a
 * table when it had nothing in it. It now passes because `OrderList` renders the
 * bare empty state INSTEAD of a table — a decision argued in the component, and
 * the assertion is what pins it.
 *
 * THE COMPONENT RENDERS THE SAME ROWS TWICE — a `<table>` for desktop and a
 * grouped `<ul>` for a phone, exactly one of which is displayed. jsdom applies
 * no stylesheet, so both are queryable and every row assertion is scoped with
 * `within()` to the one being tested. A bare `getByText` would throw on the
 * duplicate, which is the correct signal that this file must say which
 * rendering it means.
 */

function renderList(
  props: {
    orders: readonly OrderSummary[];
    footer?: React.ReactNode;
  },
) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <OrderList
        orders={props.orders}
        {...(props.footer === undefined ? {} : { footer: props.footer })}
      />
    </NextIntlClientProvider>,
  );
}

/** The desktop rendering. */
const table = () => within(screen.getByRole("table"));
/** The phone rendering. */
const phoneList = () => within(screen.getByRole("list"));

describe("OrderList", () => {
  it("renders an empty state, and no table at all, when the customer has no orders", () => {
    renderList({ orders: [] });

    expect(screen.getByText("Aún no hay pedidos")).toBeInTheDocument();
    // Load-bearing: an empty customer history is not a table with no rows. See
    // the note in the component — the admin "keep the headings" argument is
    // about filters, and this screen has none.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("names every column with a scoped header", () => {
    renderList({ orders: [buildOrderSummary()] });

    for (const header of ["Pedido", "Fecha", "Estado", "Artículos", "Total"]) {
      expect(table().getByRole("columnheader", { name: header })).toHaveAttribute(
        "scope",
        "col",
      );
    }
  });

  it("renders each order with its number, status, item count and total", () => {
    renderList({ orders: [buildOrderSummary()] });

    const row = table();
    expect(row.getByText("AK-2026-000123")).toBeInTheDocument();
    expect(row.getByText("Entregado")).toBeInTheDocument();
    expect(row.getByText("2 artículos")).toBeInTheDocument();
    // 12_098_000 centavos in es-CO: "$ 120.980" — whole pesos, dot grouping.
    expect(row.getByText(/120\.980/)).toBeInTheDocument();
  });

  it("gives each row link a name that says what following it does", () => {
    renderList({ orders: [buildOrderSummary()] });

    // The visible text is the bare order number; the accessible name is the
    // translated `viewDetail` sentence.
    expect(
      table().getByRole("link", { name: "Ver detalle del pedido AK-2026-000123" }),
    ).toHaveAttribute("href", "/orders/AK-2026-000123");
  });

  it("renders the same orders as phone rows, linking to the same detail page", () => {
    renderList({ orders: [buildOrderSummary()] });

    const row = phoneList().getByRole("link");
    expect(row).toHaveAttribute("href", "/orders/AK-2026-000123");
    // The whole row is the link on a phone, so its name is its content rather
    // than an aria-label — the number, the date, the count, the status and the
    // total all read out.
    expect(row).toHaveAccessibleName(/AK-2026-000123/);
    expect(within(row).getByText("Entregado")).toBeInTheDocument();
    expect(within(row).getByText(/120\.980/)).toBeInTheDocument();
  });

  it("renders one row per order in both renderings", () => {
    const second = buildOrderSummary({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      orderNumber: "AK-2026-000124",
      status: "SHIPPED",
    });

    renderList({ orders: [buildOrderSummary(), second] });

    // One header row plus two data rows.
    expect(table().getAllByRole("row")).toHaveLength(3);
    expect(phoneList().getAllByRole("listitem")).toHaveLength(2);
    expect(table().getByText("Enviado")).toBeInTheDocument();
  });
});

/**
 * The footer slot, exercised with the real `CursorPagination` rather than a
 * stand-in.
 *
 * The point is not to re-test the control — `ui/pagination.test.tsx` does that —
 * but to pin the composition: that the list renders the bar exactly ONCE across
 * both renderings, that it survives the empty state, and that the hrefs it
 * produces carry the whole cursor stack rather than replacing it. A control that
 * `set()`s the cursor instead of appending strands the reader with no way back,
 * and that failure is invisible until someone presses "previous".
 */
describe("OrderList pagination slot", () => {
  const LABELS: PaginationLabels = {
    nav: "Paginación",
    first: "Primera",
    previous: "Pedidos anteriores",
    next: "Pedidos más antiguos",
    page: (page) => `Página ${page}`,
    perPage: "Por página",
    showing: ({ hasMore }) => (hasMore ? "Mostrando 1 pedido · hay más antiguos" : "Mostrando 1 pedido"),
  };

  function pagination(searchParams: Readonly<Record<string, string | readonly string[]>>) {
    return (
      <CursorPagination
        labels={LABELS}
        pathname="/orders"
        searchParams={searchParams}
        itemCount={1}
        pageSize={25}
        hasMore
        nextCursor="cursor-2"
      />
    );
  }

  it("pushes onto the cursor stack rather than replacing it", () => {
    renderList({
      orders: [buildOrderSummary()],
      footer: pagination({ cursor: ["cursor-1"], limit: "25" }),
    });

    const nav = within(screen.getByRole("navigation", { name: "Paginación" }));
    expect(nav.getByRole("link", { name: "Pedidos más antiguos" })).toHaveAttribute(
      "href",
      "/orders?limit=25&cursor=cursor-1&cursor=cursor-2",
    );
    // "Previous" pops one level, which at depth 1 is the unparameterised list.
    expect(nav.getByRole("link", { name: "Pedidos anteriores" })).toHaveAttribute(
      "href",
      "/orders?limit=25",
    );
  });

  it("renders the bar once, not once per rendering", () => {
    renderList({
      orders: [buildOrderSummary()],
      footer: pagination({ cursor: ["cursor-1"] }),
    });

    // Two copies would put every pagination link in the document twice and give
    // the page two identically-named navigation landmarks.
    expect(screen.getAllByRole("navigation", { name: "Paginación" })).toHaveLength(1);
  });

  it("keeps the bar in the empty state, so an empty deep page has a way back", () => {
    renderList({ orders: [], footer: pagination({ cursor: ["cursor-1"] }) });

    expect(screen.getByText("Aún no hay pedidos")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Pedidos anteriores" }),
    ).toHaveAttribute("href", "/orders");
  });
});
