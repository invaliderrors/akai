import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RevenueChart } from "./revenue-chart";
import type { DailyRevenuePoint } from "@/lib/admin/schemas";

function point(day: string, grossTotal: number): DailyRevenuePoint {
  return { day, grossTotal };
}

describe("<RevenueChart />", () => {
  it("renders nothing for fewer than two points — a line needs at least two", () => {
    const { container } = render(
      <RevenueChart points={[point("2026-06-01T00:00:00.000Z", 1_000)]} label="Daily revenue" />,
    );

    expect(container.querySelector("svg")).not.toBeInTheDocument();
  });

  it("renders nothing for an empty series", () => {
    const { container } = render(<RevenueChart points={[]} label="Daily revenue" />);

    expect(container.querySelector("svg")).not.toBeInTheDocument();
  });

  it("draws an accessible chart, named by the caller's label", () => {
    render(
      <RevenueChart
        points={[point("2026-06-01T00:00:00.000Z", 1_000), point("2026-06-02T00:00:00.000Z", 2_000)]}
        label="Ingresos brutos diarios"
      />,
    );

    expect(screen.getByRole("img", { name: "Ingresos brutos diarios" })).toBeInTheDocument();
  });

  it("draws a flat line at the floor rather than a NaN path when every day is zero", () => {
    const { container } = render(
      <RevenueChart
        points={[point("2026-06-01T00:00:00.000Z", 0), point("2026-06-02T00:00:00.000Z", 0)]}
        label="Daily revenue"
      />,
    );

    const path = container.querySelector("path");
    expect(path?.getAttribute("d")).not.toContain("NaN");
  });

  it("plots one coordinate per point", () => {
    const points = [
      point("2026-06-01T00:00:00.000Z", 500),
      point("2026-06-02T00:00:00.000Z", 1_500),
      point("2026-06-03T00:00:00.000Z", 900),
    ];
    const { container } = render(<RevenueChart points={points} label="Daily revenue" />);

    const path = container.querySelector("path");
    // "M x,y Lx,y Lx,y" — one moveto plus (n - 1) linetos for n points.
    expect(path?.getAttribute("d")?.split("L")).toHaveLength(points.length);
  });
});
