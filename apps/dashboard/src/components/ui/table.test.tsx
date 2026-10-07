import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import Link from "next/link";

import { Badge } from "./badge";
import { IconButton } from "./button";
import { EmptyState, ErrorState } from "./states";
import { DataTable, type Column, type RowTone, type TableExpansion, type TableSelection } from "./table";
import { clearTableSelection, useTableSelection } from "./table-selection";

/**
 * `ErrorState` reads the
 * `errors` namespace, so every render goes through one provider — otherwise a
 * test fails for the wrong reason the first time a table grows a link.
 */
const MESSAGES = {
  errors: {
    INTERNAL_ERROR: "Algo ha fallado por nuestra parte.",
    generic: "Algo ha fallado.",
  },
};

function renderTable(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="es" messages={MESSAGES}>
      {ui}
    </NextIntlClientProvider>,
  );
}

interface Order {
  readonly id: string;
  readonly number: string;
  readonly email: string;
  readonly items: number;
  readonly total: string;
  readonly tone: RowTone;
  readonly status: string;
}

const ORDERS: readonly Order[] = [
  {
    id: "o-412",
    number: "AK-2026-000412",
    email: "ana@example.es",
    items: 3,
    total: "89,80 €",
    tone: "default",
    status: "Preparando",
  },
  {
    id: "o-411",
    number: "AK-2026-000411",
    email: "l.vidal@example.es",
    items: 1,
    total: "54,90 €",
    tone: "attention",
    status: "Importe no coincide",
  },
  {
    id: "o-410",
    number: "AK-2026-000410",
    email: "marc.r@example.es",
    items: 2,
    total: "74,85 €",
    tone: "default",
    status: "Pagado",
  },
];

const COLUMNS: readonly Column<Order>[] = [
  {
    key: "number",
    header: "Pedido",
    kind: "identifier",
    cell: (order) => <Link href={`/admin/pedidos/${order.number}`}>{order.number}</Link>,
  },
  {
    key: "status",
    header: "Estado",
    cell: (order, state) => (
      <Badge
        tone={order.tone === "attention" ? "attention" : "success"}
        label={order.status}
        density="compact"
        onAccent={state.selected}
      />
    ),
  },
  { key: "email", header: "Cliente", cell: (order) => order.email },
  { key: "items", header: "Artículos", kind: "numeric", cell: (order) => order.items },
  { key: "total", header: "Total", kind: "numeric", cell: (order) => order.total },
  {
    key: "actions",
    header: "Acciones",
    kind: "actions",
    cell: (order) => <IconButton label={`Más · ${order.number}`} icon="ellipsis" size="mini" />,
  },
];

const EXPANSION: TableExpansion<Order> = {
  expandedId: undefined,
  pathname: "/admin/pedidos",
  searchParams: { status: "PAID", limit: "50", cursor: ["c1", "c2"] },
  header: "Detalle",
  label: (order, expanded) =>
    `${expanded ? "Ocultar" : "Mostrar"} el detalle de ${order.number}`,
  render: (order) => <p>{`Motivo: ${order.status}`}</p>,
};

function table(): HTMLElement {
  return screen.getByRole("table", { name: "Pedidos" });
}

/** The `<tr>` a piece of cell text sits in. */
function rowOf(text: string): HTMLTableRowElement {
  const row = screen.getByText(text).closest("tr");
  if (row === null) {
    throw new Error(`"${text}" is not inside a row`);
  }
  return row;
}

function cellAt(row: HTMLElement, index: number): HTMLElement {
  const cell = within(row).getAllByRole("cell")[index];
  if (cell === undefined) {
    throw new Error(`row has no cell at ${index}`);
  }
  return cell;
}

describe("<DataTable />", () => {
  /**
   * REGRESSION: the sticky header offset must be 0.
   *
   * `top-[var(--toolbar-h)]` shipped here and broke every table on the site.
   * The wrapper carries `overflow-x-auto`, which forces `overflow-y` to `auto`
   * too, making the WRAPPER the scrollport — so the offset is measured from its
   * top edge, not the page's. A sticky offset applies whether or not the
   * scrollport currently scrolls, and a sticky table cell's containing block is
   * the table, so every `<th>` slid 52px down over the first two body rows: an
   * empty header strip with the column labels overprinting row one.
   *
   * jsdom does no layout, so nothing here can observe the displacement. The
   * class is the only thing a unit test can hold, and it is enough: the two
   * facts that have to stay true together are that the wrapper is the
   * scrollport and that the offset is zero.
   */
  it("sticks the header to the wrapper, not to the toolbar", () => {
    const { container } = renderTable(
      <DataTable caption="Pedidos" columns={COLUMNS} rows={ORDERS} rowKey={(order) => order.id} />,
    );

    const header = screen.getAllByRole("columnheader")[0];
    expect(header, "the table should render column headers").toBeDefined();
    expect(header?.className).toContain("sticky");
    expect(
      header?.className,
      "the offset must be 0 — the scrollport is the overflow-x wrapper, so any " +
        "non-zero top pushes the header down over the body rows",
    ).toContain("top-0");
    expect(header?.className).not.toContain("var(--toolbar-h)");

    // The other half of the invariant: if this wrapper ever loses its overflow,
    // the page becomes the scrollport and top-0 stops being the right answer.
    expect(
      container.querySelector(".overflow-x-auto"),
      "the table is wrapped in its own scrollport so a wide table never scrolls the page",
    ).not.toBeNull();
  });

  it("names itself with a caption and gives every heading scope=col", () => {
    // The caption is the element a table role is actually named by; `scope` is
    // what lets a screen reader say "Total, 89,80 €" instead of reading a grid
    // of unlabelled numbers.
    renderTable(
      <DataTable caption="Pedidos" columns={COLUMNS} rows={ORDERS} rowKey={(order) => order.id} />,
    );

    const headers = within(table()).getAllByRole("columnheader");
    expect(headers).toHaveLength(6);
    for (const header of headers) {
      expect(header).toHaveAttribute("scope", "col");
    }
  });

  it("names the actions column without printing the word over it", () => {
    renderTable(
      <DataTable caption="Pedidos" columns={COLUMNS} rows={ORDERS} rowKey={(order) => order.id} />,
    );

    const header = within(table()).getByRole("columnheader", { name: "Acciones" });
    const label = within(header).getByText("Acciones");
    expect(label).toHaveClass("sr-only");
  });

  it("keeps row actions in the DOM and in the tab order when nothing is hovered", async () => {
    // The version of this that ships broken is `display: none` until hover: a
    // hidden element is not focusable, so every row action in the product
    // becomes unreachable by keyboard and no hover-driven test notices.
    const user = userEvent.setup();
    renderTable(
      <DataTable caption="Pedidos" columns={COLUMNS} rows={ORDERS} rowKey={(order) => order.id} />,
    );

    const action = screen.getByRole("button", { name: "Más · AK-2026-000412" });
    expect(action).toBeInTheDocument();

    const reveal = cellAt(rowOf("AK-2026-000412"), 5).firstElementChild;
    expect(reveal?.className).toContain("[@media(hover:hover)]:opacity-0");
    expect(reveal?.className).toContain("group-hover/row:opacity-100");
    expect(reveal?.className).toContain("focus-within:opacity-100");
    expect(reveal?.className).not.toContain("hidden");

    // Tab from the row's own link and the action is the next stop — no pointer
    // has been near the row.
    await user.tab();
    expect(screen.getByRole("link", { name: "AK-2026-000412" })).toHaveFocus();
    await user.tab();
    expect(action).toHaveFocus();
  });

  it("pairs the attention row with an attention badge rather than relying on colour", () => {
    // Attention is the loudest state in the product and it is rationed to two
    // cases. Colour alone would leave it invisible in greyscale, to a
    // colour-blind operator, and on a printed picking sheet — so the row is
    // required to carry the word AND the symbol.
    renderTable(
      <DataTable
        caption="Pedidos"
        columns={COLUMNS}
        rows={ORDERS}
        rowKey={(order) => order.id}
        rowTone={(order) => order.tone}
      />,
    );

    const row = rowOf("AK-2026-000411");
    const badge = within(cellAt(row, 1)).getByText("Importe no coincide");
    expect(badge).toHaveClass("bg-[var(--attention-fill)]");
    expect(badge.querySelector("svg")).not.toBeNull();

    expect(row.className).toContain("bg-[var(--danger-fill)]");
    // The rail is on the leading CELL, not the row: `border-collapse: collapse`
    // drops a box-shadow on a `<tr>` in Chrome and Safari, silently.
    expect(cellAt(row, 0).className).toContain("shadow-[inset_3px_0_0_var(--attention-fill)]");
    expect(row.className).not.toContain("shadow-[inset_3px_0_0_var(--attention-fill)]");
  });

  it("renders the empty state outside the table, with the headings still visible", () => {
    renderTable(
      <DataTable
        caption="Pedidos"
        columns={COLUMNS}
        rows={[]}
        rowKey={(order: Order) => order.id}
        empty={
          <EmptyState
            density="table"
            reason="no-matches"
            title="Ningún pedido coincide"
            body="Prueba a quitar el filtro de fecha."
          />
        }
      />,
    );

    expect(within(table()).getAllByRole("columnheader")).toHaveLength(6);
    // The header row is the only row: no `<td colspan>` carrying the message,
    // and no phantom data rows.
    expect(screen.getAllByRole("row")).toHaveLength(1);

    const message = screen.getByText("Ningún pedido coincide");
    expect(table().contains(message)).toBe(false);
  });

  it("renders the error state outside the table, and it outranks the rows", () => {
    renderTable(
      <DataTable
        caption="Pedidos"
        columns={COLUMNS}
        rows={ORDERS}
        rowKey={(order) => order.id}
        error={
          <ErrorState
            density="table"
            audience="admin"
            title="No se pudieron cargar los pedidos"
            code="INTERNAL_ERROR"
            requestId={null}
            detail="502 upstream timeout · orders-projection"
          />
        }
      />,
    );

    // Rows fetched before the failure are not evidence of anything.
    expect(screen.queryByText("AK-2026-000412")).toBeNull();
    expect(within(table()).getAllByRole("columnheader")).toHaveLength(6);

    const alert = screen.getByRole("alert");
    expect(table().contains(alert)).toBe(false);
    expect(within(alert).getByText("502 upstream timeout · orders-projection")).toBeInTheDocument();
  });

  it("expands through a link that carries aria-expanded and keeps every other param", () => {
    renderTable(
      <DataTable
        caption="Pedidos"
        columns={COLUMNS}
        rows={ORDERS}
        rowKey={(order) => order.id}
        expansion={EXPANSION}
      />,
    );

    const trigger = screen.getByRole("link", {
      name: "Mostrar el detalle de AK-2026-000412",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Nothing to control until the panel exists.
    expect(trigger).not.toHaveAttribute("aria-controls");

    const href = trigger.getAttribute("href") ?? "";
    expect(href).toContain("expand=o-412");
    expect(href).toContain("status=PAID");
    expect(href).toContain("limit=50");
    // The cursor stack is a REPEATED param, and losing an entry of it drops the
    // operator back a page for the crime of opening a row.
    expect(href).toContain("cursor=c1");
    expect(href).toContain("cursor=c2");
  });

  it("opens a sibling row spanning every column, and the same link collapses it", () => {
    renderTable(
      <DataTable
        caption="Pedidos"
        columns={COLUMNS}
        rows={ORDERS}
        rowKey={(order) => order.id}
        expansion={{ ...EXPANSION, expandedId: "o-412" }}
      />,
    );

    const trigger = screen.getByRole("link", {
      name: "Ocultar el detalle de AK-2026-000412",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const controls = trigger.getAttribute("aria-controls");
    expect(controls).toBe("o-412-detail");
    const panel = controls === null ? null : document.getElementById(controls);
    expect(panel).not.toBeNull();

    const panelCell = within(rowOf("Motivo: Preparando")).getByRole("cell");
    expect(panelCell).toHaveAttribute("colspan", "7");
    expect(panelCell).toHaveTextContent("Motivo: Preparando");

    // One link, both directions: clearing the param is what collapses the row,
    // so a second press is not a no-op that reopens it.
    expect(trigger.getAttribute("href") ?? "").not.toContain("expand=");
  });

  it("stripes from the data index, so an open row cannot invert the zebra", () => {
    // `nth-child` counts the expansion panel as a sibling row and flips every
    // stripe after it. The index into `rows` is the only counter that means
    // "the second order".
    renderTable(
      <DataTable
        caption="Pedidos"
        columns={COLUMNS}
        rows={ORDERS}
        rowKey={(order) => order.id}
        expansion={{ ...EXPANSION, expandedId: "o-412" }}
      />,
    );

    expect(rowOf("AK-2026-000411").className).toContain("bg-[var(--zebra)]");
    expect(rowOf("AK-2026-000410").className).not.toContain("bg-[var(--zebra)]");
  });

  it("puts identifiers in mono and amounts in right-aligned tabular figures", () => {
    // Mono is for things compared character by character against a label. Money
    // is read as a magnitude and stays on the sans face.
    renderTable(
      <DataTable caption="Pedidos" columns={COLUMNS} rows={ORDERS} rowKey={(order) => order.id} />,
    );

    const row = rowOf("AK-2026-000412");
    expect(cellAt(row, 0).className).toContain("font-mono");

    const total = cellAt(row, 4);
    expect(total.className).toContain("text-end");
    expect(total.className).toContain("tabular-nums");
    expect(total.className).not.toContain("font-mono");
  });

  it("keeps the identifier a link on a selected row and repaints it instead of removing it", () => {
    // The artboard draws the selected row's order number as plain text. Taking
    // the link away would delete the only route to that order for as long as the
    // row is selected — so it is painted for the accent fill and left alone.
    renderTable(
      <DataTable
        caption="Pedidos"
        columns={COLUMNS}
        rows={ORDERS}
        rowKey={(order) => order.id}
        rowTone={(order) => (order.id === "o-412" ? "selected" : "default")}
      />,
    );

    expect(screen.getByRole("link", { name: "AK-2026-000412" })).toBeInTheDocument();

    const row = rowOf("AK-2026-000412");
    expect(row.className).toContain("bg-[var(--accent)]");
    expect(row.className).not.toContain("hover:bg-[var(--fill-tertiary)]");
    expect(cellAt(row, 0).className).toContain("text-[var(--label-on-accent)]");
  });

  it("hands the row's state to the cell so a badge can survive the accent fill", () => {
    renderTable(
      <DataTable
        caption="Pedidos"
        columns={COLUMNS}
        rows={ORDERS}
        rowKey={(order) => order.id}
        rowTone={(order) => (order.id === "o-412" ? "selected" : "default")}
      />,
    );

    // Every pale `*-fill` tint disappears on `--accent`; the badge has to be
    // told, and it can only be told if the cell renderer knows.
    expect(screen.getByText("Preparando")).toHaveClass("bg-white/20");
    expect(screen.getByText("Pagado")).toHaveClass("bg-[var(--success-fill)]");
  });

  it("draws skeleton rows that keep the columns, announced exactly once", () => {
    renderTable(
      <DataTable
        caption="Pedidos"
        columns={COLUMNS}
        rows={ORDERS}
        rowKey={(order) => order.id}
        loading={{ label: "Cargando pedidos", rows: 3 }}
      />,
    );

    // Header plus three placeholders. A skeleton must never resolve to a page of
    // real rows a frame early.
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.queryByText("AK-2026-000412")).toBeNull();

    const status = screen.getAllByRole("status");
    expect(status).toHaveLength(1);
    expect(status[0]).toHaveTextContent("Cargando pedidos");
    // The announcement lives outside the table: a live region buried in a `<td>`
    // is read as a cell in table-navigation mode.
    expect(table().contains(status[0] ?? null)).toBe(false);

    const rows = screen.getAllByRole("row").slice(1);
    for (const row of rows) {
      expect(row).toHaveAttribute("aria-busy", "true");
      expect(within(row).getAllByRole("cell")).toHaveLength(6);
    }
  });

  it("shows the skeleton, not the empty state, while a list with no rows is loading", () => {
    // A loading table HAS no rows, so an `empty` slot checked first answers
    // "you have no orders" to a question nobody has finished asking.
    renderTable(
      <DataTable
        caption="Pedidos"
        columns={COLUMNS}
        rows={[]}
        rowKey={(order: Order) => order.id}
        loading={{ label: "Cargando pedidos", rows: 2 }}
        empty={<EmptyState density="table" title="Ningún pedido todavía" body="Aún no hay nada." />}
      />,
    );

    expect(screen.queryByText("Ningún pedido todavía")).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("status")).toHaveTextContent("Cargando pedidos");
  });

  it("scrolls itself sideways rather than the page, and takes a floor it can be told about", () => {
    const { container, rerender } = renderTable(
      <DataTable caption="Pedidos" columns={COLUMNS} rows={ORDERS} rowKey={(order) => order.id} />,
    );

    const scroller = table().parentElement;
    expect(scroller?.className).toContain("overflow-x-auto");
    expect(table().className).toContain("min-w-[760px]");
    expect(container.firstElementChild?.className).toContain("rounded-[var(--r-card)]");

    rerender(
      <NextIntlClientProvider locale="es" messages={MESSAGES}>
        <DataTable
          caption="Pedidos"
          columns={COLUMNS}
          rows={ORDERS}
          rowKey={(order: Order) => order.id}
          minWidth="none"
          frame={false}
        />
      </NextIntlClientProvider>,
    );

    expect(table().className).not.toContain("min-w-[");
    // Inside a Card the frame is already drawn, so the header takes a rule above
    // it instead of the frame's own edge.
    expect(container.firstElementChild?.className).not.toContain("rounded-[var(--r-card)]");
    expect(within(table()).getAllByRole("columnheader")[0]?.className).toContain("border-t");
  });

  it("gives the sticky header the glass fill it needs to cover scrolled rows", () => {
    // This assertion used to also require `top-[var(--toolbar-h)]`, and so it
    // pinned the defect rather than the intent — see the offset regression at
    // the top of this file for why zero is the only correct value here. The
    // fill is the part that was always right: a transparent sticky header lets
    // body rows scroll visibly underneath it.
    renderTable(
      <DataTable caption="Pedidos" columns={COLUMNS} rows={ORDERS} rowKey={(order) => order.id} />,
    );

    const header = within(table()).getAllByRole("columnheader")[0];
    expect(header?.className).toContain("sticky");
    expect(header?.className).toContain("bg-[var(--glass-fill-strong)]");
  });
});

describe("<DataTable selection />", () => {
  const SELECTION: TableSelection<Order> = {
    form: "orders-selection",
    header: "Seleccionar todos los pedidos de esta página",
    label: (order) => `Seleccionar ${order.number}`,
  };

  /** A stand-in action bar: reads the live selection exactly as a real one would. */
  function SelectionProbe() {
    const selected = useTableSelection({ form: "orders-selection", name: "selected" });
    return (
      <form id="orders-selection">
        <output data-testid="selected">{selected.join(",")}</output>
      </form>
    );
  }

  function renderSelectable(selection: TableSelection<Order> = SELECTION) {
    return renderTable(
      <>
        <SelectionProbe />
        <DataTable
          caption="Pedidos"
          columns={COLUMNS}
          rows={ORDERS}
          rowKey={(order) => order.id}
          selection={selection}
        />
      </>,
    );
  }

  function selected(): string {
    return screen.getByTestId("selected").textContent ?? "";
  }

  it("draws a named checkbox per row, bound to the caller's form, valued with the row key", () => {
    renderSelectable();

    const box = screen.getByRole("checkbox", { name: "Seleccionar AK-2026-000411" });
    expect(box.getAttribute("form")).toBe("orders-selection");
    expect(box.getAttribute("name")).toBe("selected");
    expect((box as HTMLInputElement).value).toBe("o-411");
    // Leading column: the first cell of the row.
    expect(cellAt(rowOf("AK-2026-000411"), 0).contains(box)).toBe(true);
    // The header checkbox is named, and is not itself a member of the form.
    const all = screen.getByRole("checkbox", { name: SELECTION.header });
    expect(all.getAttribute("form")).toBeNull();
  });

  it("reports the selection in ROW order, whatever order it was clicked in", async () => {
    const user = userEvent.setup();
    renderSelectable();

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar AK-2026-000410" }));
    await user.click(screen.getByRole("checkbox", { name: "Seleccionar AK-2026-000412" }));

    expect(selected()).toBe("o-412,o-410");
  });

  it("select-all selects and clears the page, and shows the mixed state in between", async () => {
    const user = userEvent.setup();
    renderSelectable();
    const all = screen.getByRole<HTMLInputElement>("checkbox", { name: SELECTION.header });

    await user.click(screen.getByRole("checkbox", { name: "Seleccionar AK-2026-000411" }));
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);

    await user.click(all);
    expect(selected()).toBe("o-412,o-411,o-410");
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);

    await user.click(all);
    expect(selected()).toBe("");
  });

  it("is operable from the keyboard: Space toggles the focused box", async () => {
    const user = userEvent.setup();
    renderSelectable();

    screen.getByRole("checkbox", { name: "Seleccionar AK-2026-000412" }).focus();
    await user.keyboard(" ");

    expect(selected()).toBe("o-412");
  });

  it("leaves unselectable rows out of select-all", async () => {
    const user = userEvent.setup();
    renderSelectable({ ...SELECTION, isSelectable: (order) => order.tone !== "attention" });

    expect(screen.getByRole("checkbox", { name: "Seleccionar AK-2026-000411" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: SELECTION.header }));

    expect(selected()).toBe("o-412,o-410");
  });

  it("can be cleared programmatically after an action", async () => {
    const user = userEvent.setup();
    renderSelectable();
    await user.click(screen.getByRole("checkbox", { name: SELECTION.header }));

    act(() => {
      clearTableSelection({ form: "orders-selection", name: "selected" });
    });

    expect(selected()).toBe("");
  });

  it("renders no checkboxes at all without the prop", () => {
    renderTable(
      <DataTable caption="Pedidos" columns={COLUMNS} rows={ORDERS} rowKey={(order) => order.id} />,
    );
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});
