import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  FilterBar,
  buildFilterHref,
  single,
  type FilterBarLabels,
  type FilterField,
} from "./filter-bar";

/**
 * `Link` is mocked down to the anchor it renders. The href it is GIVEN is what
 * is under test.
 */
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    "aria-label": ariaLabel,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
    "aria-label"?: string;
  }) => (
    <a href={href} className={className} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));

const LABELS: FilterBarLabels = {
  apply: "Aplicar",
  clear: "Limpiar",
  active: "Filtros:",
  remove: (filter) => `Quitar filtro ${filter}`,
};

const FIELDS: readonly FilterField[] = [
  {
    kind: "text",
    name: "orderNumber",
    label: "Nº de pedido",
    value: undefined,
    placeholder: "AK-2026-",
    mono: true,
  },
  { kind: "text", name: "email", label: "Correo", value: undefined, width: "lg" },
  {
    kind: "select",
    name: "status",
    label: "Estado",
    value: undefined,
    anyLabel: "Todos",
    options: [
      { value: "PAYMENT_MISMATCH", label: "Necesitan decisión" },
      { value: "PAID", label: "Pagado" },
    ],
  },
  { kind: "checkbox", name: "includeDeleted", label: "Incluir eliminados", checked: false },
];

function withValues(overrides: {
  readonly orderNumber?: string;
  readonly email?: string;
  readonly status?: string;
  readonly includeDeleted?: boolean;
}): readonly FilterField[] {
  return FIELDS.map((field) => {
    if (field.kind === "checkbox") {
      return { ...field, checked: overrides.includeDeleted ?? false };
    }
    if (field.name === "orderNumber") {
      return { ...field, value: overrides.orderNumber };
    }
    if (field.name === "email") {
      return { ...field, value: overrides.email };
    }
    return { ...field, value: overrides.status };
  });
}

describe("<FilterBar />", () => {
  it("is a GET form with no action, so it submits to the list it filters", () => {
    render(
      <FilterBar
        label="Filtrar pedidos"
        fields={FIELDS}
        pathname="/admin/orders"
        labels={LABELS}
      />,
    );

    const form = screen.getByRole("search", { name: "Filtrar pedidos" });
    expect(form.tagName).toBe("FORM");
    expect(form).toHaveAttribute("method", "get");
    // Setting action={pathname} would drop /es or /en on every submit.
    expect(form).not.toHaveAttribute("action");
  });

  it("gives every field a labelled control carrying the URL's value", () => {
    render(
      <FilterBar
        label="Filtrar pedidos"
        fields={withValues({
          orderNumber: "AK-2026-000123",
          email: "ana@example.com",
          status: "PAID",
          includeDeleted: true,
        })}
        pathname="/admin/orders"
        labels={LABELS}
      />,
    );

    const orderNumber = screen.getByLabelText("Nº de pedido");
    expect(orderNumber).toHaveAttribute("name", "orderNumber");
    expect(orderNumber).toHaveValue("AK-2026-000123");
    expect(orderNumber).toHaveAttribute("placeholder", "AK-2026-");

    expect(screen.getByLabelText("Correo")).toHaveValue("ana@example.com");
    expect(screen.getByLabelText("Estado")).toHaveValue("PAID");
    expect(screen.getByLabelText("Incluir eliminados")).toBeChecked();
  });

  it("offers the any-value option first and selects it when nothing is filtered", () => {
    render(
      <FilterBar
        label="Filtrar pedidos"
        fields={FIELDS}
        pathname="/admin/orders"
        labels={LABELS}
      />,
    );

    expect(screen.getByLabelText("Estado")).toHaveValue("");
    expect(screen.getByRole("option", { name: "Todos" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Necesitan decisión" })).toBeInTheDocument();
  });

  it("renders no token and no selection for a value that matches no option", () => {
    render(
      <FilterBar
        label="Filtrar pedidos"
        fields={withValues({ status: "ON_HOLD" })}
        pathname="/admin/orders"
        searchParams={{ status: "ON_HOLD" }}
        labels={LABELS}
      />,
    );

    // The page narrows through the contract enum before querying, so a value we
    // cannot name is a value the list was not filtered by. Claiming otherwise
    // in the token row would be the one lie an operator reads it to avoid.
    expect(screen.getByLabelText("Estado")).toHaveValue("");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("draws one token per active filter, naming the filter in each remove control", () => {
    render(
      <FilterBar
        label="Filtrar pedidos"
        fields={withValues({ status: "PAYMENT_MISMATCH", includeDeleted: true })}
        pathname="/admin/orders"
        searchParams={{ status: "PAYMENT_MISMATCH", includeDeleted: "true" }}
        labels={LABELS}
      />,
    );

    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Estado: Necesitan decisión",
      // A boolean filter has no value to name.
      "Incluir eliminados",
    ]);

    expect(screen.getByRole("link", { name: "Quitar filtro Estado" })).toHaveAttribute(
      "href",
      "/admin/orders?includeDeleted=true",
    );
    expect(
      screen.getByRole("link", { name: "Quitar filtro Incluir eliminados" }),
    ).toHaveAttribute("href", "/admin/orders?status=PAYMENT_MISMATCH");
  });

  it("reads a text token as label plus the typed value", () => {
    render(
      <FilterBar
        label="Filtrar pedidos"
        fields={withValues({ email: "ana@example.com" })}
        pathname="/admin/orders"
        searchParams={{ email: "ana@example.com" }}
        labels={LABELS}
      />,
    );

    expect(screen.getByRole("listitem")).toHaveTextContent("Correo: ana@example.com");
  });

  it("keeps unrelated params but drops the cursor and the expansion when a token goes", () => {
    render(
      <FilterBar
        label="Filtrar pedidos"
        fields={withValues({ status: "PAID", email: "ana@example.com" })}
        pathname="/admin/orders"
        searchParams={{
          status: "PAID",
          email: "ana@example.com",
          limit: "50",
          cursor: ["c1", "c2"],
          expand: "ord_9",
        }}
        labels={LABELS}
      />,
    );

    expect(screen.getByRole("link", { name: "Quitar filtro Estado" })).toHaveAttribute(
      "href",
      "/admin/orders?email=ana%40example.com&limit=50",
    );
  });

  it("hides the token row and the clear link when nothing is filtered", () => {
    render(
      <FilterBar
        label="Filtrar pedidos"
        fields={FIELDS}
        pathname="/admin/orders"
        searchParams={{ limit: "50" }}
        labels={LABELS}
      />,
    );

    expect(screen.queryByText("Filtros:")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Limpiar" })).not.toBeInTheDocument();
  });

  it("clears every filter through a link, keeping the page size", () => {
    render(
      <FilterBar
        label="Filtrar pedidos"
        fields={withValues({ status: "PAID", includeDeleted: true })}
        pathname="/admin/orders"
        searchParams={{ status: "PAID", includeDeleted: "true", limit: "50", cursor: "c1" }}
        labels={LABELS}
      />,
    );

    // A link, not <button type="reset">: reset restores the controls and never
    // submits, so the list would keep showing the filters just cleared.
    expect(screen.getByRole("link", { name: "Limpiar" })).toHaveAttribute(
      "href",
      "/admin/orders?limit=50",
    );
  });

  it("re-submits unrelated params as hidden inputs, but never a position param", () => {
    const { container } = render(
      <FilterBar
        label="Filtrar pedidos"
        fields={withValues({ status: "PAID" })}
        pathname="/admin/orders"
        searchParams={{
          status: "PAID",
          limit: "50",
          cursor: ["c1", "c2"],
          expand: "ord_9",
          tab: ["a", "b"],
        }}
        labels={LABELS}
      />,
    );

    const hidden = [...container.querySelectorAll('input[type="hidden"]')].map((input) => [
      input.getAttribute("name"),
      input.getAttribute("value"),
    ]);

    // `limit` rides along or the operator's page size dies on every Apply; the
    // cursor and the expansion are positions inside the set that just changed;
    // `status` is a field and would otherwise be submitted twice.
    expect(hidden).toEqual([
      ["limit", "50"],
      ["tab", "a"],
      ["tab", "b"],
    ]);
  });

  it("submits the form from the Apply button", () => {
    render(
      <FilterBar
        label="Filtrar pedidos"
        fields={FIELDS}
        pathname="/admin/orders"
        labels={LABELS}
      />,
    );

    expect(screen.getByRole("button", { name: "Aplicar" })).toHaveAttribute("type", "submit");
  });

  it("kills the base outline on every control before painting its own ring", () => {
    const { container } = render(
      <FilterBar
        label="Filtrar pedidos"
        fields={withValues({ status: "PAID" })}
        pathname="/admin/orders"
        searchParams={{ status: "PAID" }}
        labels={LABELS}
      />,
    );

    // `:focus-visible` lives inside @layer base, so a utility wins — but only
    // if it is emitted, which is what this pins.
    const focusable = [
      ...container.querySelectorAll("input, select, a[aria-label]"),
    ];
    expect(focusable.length).toBeGreaterThan(0);
    for (const element of focusable) {
      expect(element.className).toContain("focus-visible:outline-none");
      expect(element.className).toContain("var(--focus-ring)");
    }
  });
});

describe("single()", () => {
  it("takes the first usable value of a repeated param", () => {
    expect(single(["a", "b"])).toBe("a");
    expect(single("a")).toBe("a");
  });

  it("reads an empty value as no filter", () => {
    // What an emptied text box submits: `?email=`. Without this the token row
    // would show a blank chip and the API would be sent email="".
    expect(single("")).toBeUndefined();
    expect(single(["", "b"])).toBe("b");
    expect(single([])).toBeUndefined();
    expect(single(undefined)).toBeUndefined();
  });
});

describe("buildFilterHref()", () => {
  const searchParams = {
    status: "PAID",
    email: "ana@example.com",
    limit: "50",
    expand: "ord_9",
    cursor: ["c1", "c2"],
  };

  it("carries unrelated params, limit and expand through", () => {
    expect(buildFilterHref({ pathname: "/admin/orders", searchParams })).toBe(
      "/admin/orders?status=PAID&email=ana%40example.com&limit=50&expand=ord_9&cursor=c1&cursor=c2",
    );
  });

  it("keeps a repeated param repeated, so a cursor stack survives", () => {
    const href = buildFilterHref({
      pathname: "/admin/orders",
      searchParams,
      set: { expand: "ord_4" },
    });

    expect(href).toContain("cursor=c1&cursor=c2");
    expect(href).toContain("expand=ord_4");
    expect(href).not.toContain("expand=ord_9");
  });

  it("removes a param set to undefined or to an empty string", () => {
    expect(
      buildFilterHref({
        pathname: "/admin/orders",
        searchParams: { status: "PAID", limit: "50" },
        set: { status: undefined },
      }),
    ).toBe("/admin/orders?limit=50");

    expect(
      buildFilterHref({
        pathname: "/admin/orders",
        searchParams: { status: "PAID", limit: "50" },
        set: { status: "" },
      }),
    ).toBe("/admin/orders?limit=50");
  });

  it("drops named params and empty carried values", () => {
    expect(
      buildFilterHref({
        pathname: "/admin/orders",
        searchParams: { status: "PAID", email: "", limit: "50" },
        drop: ["status"],
      }),
    ).toBe("/admin/orders?limit=50");
  });

  it("returns the bare pathname when nothing is left", () => {
    expect(buildFilterHref({ pathname: "/admin/orders" })).toBe("/admin/orders");
    expect(
      buildFilterHref({ pathname: "/admin/orders", searchParams: { status: "PAID" }, drop: ["status"] }),
    ).toBe("/admin/orders");
  });

  it("does not mistake an inherited property for a set param", () => {
    // The keys here come from a URL a stranger can write, and
    // `"constructor" in set` is true for every object.
    expect(
      buildFilterHref({
        pathname: "/admin/orders",
        searchParams: { constructor: "x", toString: "y" },
        set: { status: "PAID" },
      }),
    ).toBe("/admin/orders?constructor=x&toString=y&status=PAID");
  });
});
