import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { SegmentedControl, type Segment } from "./segmented-control";

/**
 * The locale-aware Link needs a routing context this component never has in a
 * unit test, so it is mocked down to the anchor it renders. The href it is
 * GIVEN is the thing under test — the locale prefix Link adds is next-intl's
 * job and is covered by the e2e locale smoke.
 */
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    className,
    "aria-current": ariaCurrent,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
    "aria-current"?: "true";
  }) => (
    <a href={href} className={className} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
}));

const SEGMENTS: readonly Segment[] = [
  { value: null, label: "Todos" },
  { value: "open", label: "En curso" },
  { value: "delivered", label: "Entregados" },
];

describe("<SegmentedControl />", () => {
  it("marks only the selected segment with aria-current", () => {
    render(
      <SegmentedControl
        label="Filtrar pedidos"
        segments={SEGMENTS}
        value="open"
        pathname="/orders"
        param="status"
      />,
    );

    expect(screen.getByRole("link", { current: true })).toHaveAccessibleName("En curso");
    expect(screen.getByRole("link", { name: "Todos", current: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Entregados", current: false })).toBeInTheDocument();
  });

  it("selects the clearing segment when the param is absent or empty", () => {
    const { rerender } = render(
      <SegmentedControl
        label="Filtrar pedidos"
        segments={SEGMENTS}
        value={undefined}
        pathname="/orders"
        param="status"
      />,
    );
    expect(screen.getByRole("link", { current: true })).toHaveAccessibleName("Todos");

    // `?status=` is what a form submitted with nothing chosen leaves behind; it
    // means "no filter", not "a filter nothing matches".
    rerender(
      <SegmentedControl
        label="Filtrar pedidos"
        segments={SEGMENTS}
        value=""
        pathname="/orders"
        param="status"
      />,
    );
    expect(screen.getByRole("link", { current: true })).toHaveAccessibleName("Todos");
  });

  it("carries unrelated query params across every segment", () => {
    render(
      <SegmentedControl
        label="Filtrar pedidos"
        segments={SEGMENTS}
        value="open"
        pathname="/orders"
        param="status"
        searchParams={{ limit: "50", q: "ana", status: "open" }}
      />,
    );

    // The clearing segment drops the param it owns and keeps everything else.
    expect(screen.getByRole("link", { name: "Todos" })).toHaveAttribute(
      "href",
      "/orders?limit=50&q=ana",
    );
    expect(screen.getByRole("link", { name: "Entregados" })).toHaveAttribute(
      "href",
      "/orders?limit=50&q=ana&status=delivered",
    );
  });

  it("keeps a repeated param repeated", () => {
    // The cursor stack is a repeated query param; collapsing it to one value
    // would lose every page the operator has walked back through.
    render(
      <SegmentedControl
        label="Filtrar pedidos"
        segments={SEGMENTS}
        value={undefined}
        pathname="/admin/orders"
        param="status"
        searchParams={{ cursor: ["a", "b"] }}
      />,
    );

    expect(screen.getByRole("link", { name: "En curso" })).toHaveAttribute(
      "href",
      "/admin/orders?cursor=a&cursor=b&status=open",
    );
  });

  it("drops the params it is told to reset", () => {
    render(
      <SegmentedControl
        label="Filtrar pedidos"
        segments={SEGMENTS}
        value={undefined}
        pathname="/admin/orders"
        param="status"
        searchParams={{ cursor: ["a", "b"], limit: "25" }}
        resets={["cursor"]}
      />,
    );

    expect(screen.getByRole("link", { name: "En curso" })).toHaveAttribute(
      "href",
      "/admin/orders?limit=25&status=open",
    );
  });

  it("emits a bare path when nothing is left in the query", () => {
    render(
      <SegmentedControl
        label="Filtrar pedidos"
        segments={SEGMENTS}
        value="open"
        pathname="/orders"
        param="status"
      />,
    );

    expect(screen.getByRole("link", { name: "Todos" })).toHaveAttribute("href", "/orders");
  });

  it("renders as a named navigation landmark", () => {
    render(
      <SegmentedControl
        label="Filtrar pedidos"
        segments={SEGMENTS}
        value="open"
        pathname="/orders"
        param="status"
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Filtrar pedidos" });
    expect(nav).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  it("shares the width evenly in the full-width variant", () => {
    render(
      <SegmentedControl
        label="Filtrar pedidos"
        segments={SEGMENTS}
        value="open"
        pathname="/orders"
        param="status"
        fullWidth
      />,
    );

    // The one observable difference between the phone shape and the desktop
    // one: segments stretch instead of hugging their label.
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveClass("flex-1");
    }
    expect(screen.getByRole("navigation", { name: "Filtrar pedidos" })).toHaveClass("w-full");
  });
});
