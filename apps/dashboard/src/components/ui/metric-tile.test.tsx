import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { MetricTile, MetricTileSkeleton, type DeltaSentiment, type MetricValue } from "./metric-tile";
import esMessages from "../../../messages/es.json";

/**
 * `Link` comes from `next/link`, so the attention tile needs the provider
 * in context, and `MetricTileSkeleton` reads `common.loading` through
 * `Skeleton`. Every render goes through here so no test fails for the wrong
 * reason.
 */
function renderTile(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const COUNT: MetricValue = { kind: "text", value: "614" };

/**
 * ICU separates the euro symbol with a NO-BREAK SPACE in es-ES. Written as
 * escapes rather than the literal characters, because an invisible literal is
 * exactly the one nobody notices going missing from a test file.
 */
function text(node: HTMLElement | null): string {
  return (node?.textContent ?? "").replace(/[\u00a0\u202f]/g, " ");
}

describe("<MetricTile />", () => {
  it("names the delta arrow, in both directions", () => {
    // "8,2 %" read aloud on its own is a number with no verb. The arrow is the
    // only thing in the tile that carries the direction — colour cannot, and
    // the value string deliberately does not repeat it — so it is the one glyph
    // here that must have an accessible name.
    renderTile(
      <MetricTile
        label="Ingresos netos"
        value={COUNT}
        delta={{ value: "8,2 %", direction: "up", sentiment: "positive", directionLabel: "sube" }}
      />,
    );

    expect(screen.getByRole("img", { name: "sube" })).toBeInTheDocument();
  });

  it("draws the down arrow with its own alt text", () => {
    renderTile(
      <MetricTile
        label="Pedidos"
        value={COUNT}
        delta={{ value: "3,1 %", direction: "down", sentiment: "negative", directionLabel: "baja" }}
      />,
    );

    expect(screen.getByRole("img", { name: "baja" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "sube" })).toBeNull();
  });

  it("colours the delta by SENTIMENT, not by direction", () => {
    /*
     * The case the split exists for: a refund count that is UP is bad news.
     * Direction picks the arrow, sentiment picks the ink — and if the two were
     * one flag, every rising number in the admin area would be green.
     */
    const { container } = renderTile(
      <MetricTile
        label="Reembolsos"
        value={COUNT}
        delta={{ value: "12 %", direction: "up", sentiment: "negative", directionLabel: "sube" }}
      />,
    );

    const arrow = screen.getByRole("img", { name: "sube" });
    const figure = arrow.parentElement;

    expect(figure?.className).toContain("text-[var(--danger-text)]");
    // The indicator red on the glyph, the AA-passing red on the text beside it.
    expect(arrow.getAttribute("class")).toContain("text-[var(--danger)]");
    expect(container.textContent).toContain("12 %");
  });

  it("covers every sentiment", () => {
    // A `Record` in the source makes a fourth sentiment a compile error; this
    // makes it a test failure if the list below is not updated with it.
    const SENTIMENTS: readonly DeltaSentiment[] = ["positive", "negative", "neutral"];
    const INK: Readonly<Record<DeltaSentiment, string>> = {
      positive: "text-[var(--success-text)]",
      negative: "text-[var(--danger-text)]",
      neutral: "text-[var(--label-secondary)]",
    };

    expect(SENTIMENTS).toHaveLength(Object.keys(INK).length);

    for (const sentiment of SENTIMENTS) {
      const { unmount } = renderTile(
        <MetricTile
          label="Pedidos"
          value={COUNT}
          delta={{ value: "1 %", direction: "up", sentiment, directionLabel: "sube" }}
        />,
      );
      expect(screen.getByRole("img", { name: "sube" }).parentElement?.className).toContain(
        INK[sentiment],
      );
      unmount();
    }
  });

  it("draws no chart", () => {
    /*
     * THE SPARKLINE IS ABSENT ON PURPOSE, and this is the assertion that keeps
     * it absent.
     *
     * `metricsOverviewSchema` (lib/admin/schemas.ts) is `.strict()` and holds
     * `{ revenue, ordersByStatus }` — scalar totals and a status histogram.
     * There is no series behind this tile and a strict schema means one cannot
     * arrive, so any polyline drawn here would be plotting numbers the
     * component invented. The artboard's sparkline is `viewBox="0 0 80 24"`
     * with a `<polyline>`; every icon in the kit is a 24-unit square. Both are
     * checked, so a chart cannot come back as either shape.
     */
    const { container } = renderTile(
      <MetricTile
        label="Ingresos netos"
        value={{ kind: "money", amountMinor: 4_821_490, currency: "COP" }}
        delta={{ value: "8,2 %", direction: "up", sentiment: "positive", directionLabel: "sube" }}
        footnote="Bruto menos reembolsos."
      />,
    );

    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelector("polygon")).toBeNull();
    for (const svg of Array.from(container.querySelectorAll("svg"))) {
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    }
  });

  it("renders money through AggregateMoney, so a figure above MINOR_MAX is still a euro amount", () => {
    // The defect this replaces was at admin/metrics/page.tsx:60 — a route this
    // redesign deleted — where the `isMinor(x) ? formatMoney(x) : String(x)`
    // fallback printed a bare `2400000000` for exactly the aggregates it was
    // guarding.
    const { container } = renderTile(
      <MetricTile
        label="Ingresos totales"
        value={{ kind: "money", amountMinor: 2_400_000_000, currency: "COP" }}
      />,
    );

    expect(text(container)).toContain("$ 24.000.000");
    expect(container.textContent).not.toContain("2400000000");
  });

  it("renders the label and the footnote as text", () => {
    renderTile(<MetricTile label="Pedidos" value={COUNT} footnote="Solo pagos capturados." />);

    expect(screen.getByText("Pedidos")).toBeInTheDocument();
    expect(screen.getByText("Solo pagos capturados.")).toBeInTheDocument();
    expect(screen.getByText("614")).toBeInTheDocument();
  });

  it("on attention, renders the link and drops the delta", () => {
    const { container } = renderTile(
      <MetricTile
        label="Necesitan decisión"
        value={{ kind: "text", value: "2" }}
        tone="attention"
        link={{ href: "/admin/orders?status=PAYMENT_MISMATCH", label: "Ver los 2 pedidos" }}
        // Passed, and deliberately ignored: a tile that says a decision is
        // waiting has no use for a percentage.
        delta={{ value: "3,1 %", direction: "down", sentiment: "negative", directionLabel: "baja" }}
        footnote="Importe no coincide."
      />,
    );

    expect(screen.getByRole("link", { name: /Ver los 2 pedidos/ })).toHaveAttribute(
      "href",
      "/admin/orders?status=PAYMENT_MISMATCH",
    );
    expect(screen.queryByRole("img", { name: "baja" })).toBeNull();
    expect(container.textContent).not.toContain("3,1 %");
  });

  it("paints attention as a hairline and red ink, never a solid fill", () => {
    // `--attention-fill` is solid #d70015 with white text, and its budget is
    // exactly two uses in the product. A summary OF those is not one of them.
    const { container } = renderTile(
      <MetricTile
        label="Necesitan decisión"
        value={{ kind: "text", value: "2" }}
        tone="attention"
        link={{ href: "/admin/orders", label: "Ver los 2 pedidos" }}
      />,
    );

    const tile = container.firstElementChild;
    expect(tile?.className).toContain("shadow-[0_0_0_1px_var(--danger-ring)]");
    expect(tile?.className).not.toContain("attention-fill");
    expect(screen.getByText("2").className).toContain("text-[var(--danger-text)]");
  });

  it("keeps the default tone free of the danger ring", () => {
    const { container } = renderTile(<MetricTile label="Pedidos" value={COUNT} />);

    expect(container.firstElementChild?.className).not.toContain("danger-ring");
  });

  it("sets an explicit focus ring on the link", () => {
    // `globals.css` declares `:focus-visible` inside `@layer base` so a
    // primitive's own `outline-none` wins — which means every primitive owes
    // both halves, or the link paints no focus at all.
    renderTile(
      <MetricTile
        label="Necesitan decisión"
        value={{ kind: "text", value: "2" }}
        tone="attention"
        link={{ href: "/admin/orders", label: "Ver los 2 pedidos" }}
      />,
    );

    const link = screen.getByRole("link", { name: /Ver los 2 pedidos/ });
    expect(link.className).toContain("focus-visible:outline-none");
    expect(link.className).toContain("var(--focus-ring)");
  });
});

describe("<MetricTileSkeleton />", () => {
  it("marks itself busy and announces exactly once", () => {
    // Four tiles are four independent fetches, so four skeletons can be on
    // screen at once. One live region each is already three more than anyone
    // wants; one region PER BAR would be fifteen.
    const { container } = renderTile(<MetricTileSkeleton label="Cargando ingresos…" />);

    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Cargando ingresos…");
  });

  it("falls back to the catalogue's loading string rather than announcing nothing", () => {
    renderTile(<MetricTileSkeleton />);

    const status = screen.getByRole("status");
    expect(status.textContent).not.toBe("");
    expect(status.textContent).not.toContain("common.loading");
  });

  it("occupies the same chrome as a loaded tile, so the grid does not jump", () => {
    const { container: loading } = renderTile(<MetricTileSkeleton />);
    const { container: loaded } = renderTile(<MetricTile label="Pedidos" value={COUNT} />);

    expect(loading.firstElementChild?.className).toBe(loaded.firstElementChild?.className);
  });
});
