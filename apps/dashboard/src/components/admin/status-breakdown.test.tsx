import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { StatusBreakdown } from "./status-breakdown";
import esMessages from "../../../messages/es.json";

function renderBreakdown(ui: Parameters<typeof render>[0]) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("<StatusBreakdown />", () => {
  it("never renders a raw status enum, translating each row through StatusBadge", () => {
    const { container } = renderBreakdown(
      <StatusBreakdown
        domain="return"
        entries={[{ status: "REQUESTED", count: 3 }]}
        formatCount={String}
      />,
    );

    expect(container.textContent).not.toContain("REQUESTED");
  });

  it("draws one bar per status, sized to its share of the total", () => {
    const { container } = renderBreakdown(
      <StatusBreakdown
        domain="email"
        entries={[
          { status: "DELIVERED", count: 3 },
          { status: "BOUNCED", count: 1 },
        ]}
        formatCount={String}
      />,
    );

    const bars = container.querySelectorAll("[aria-hidden] > span");
    expect(bars).toHaveLength(2);
    expect(bars[0]?.getAttribute("style")).toContain("width: 75%");
    expect(bars[1]?.getAttribute("style")).toContain("width: 25%");
  });

  it("emphasizes only the row the caller names, leaving the rest their default colour", () => {
    const { container } = renderBreakdown(
      <StatusBreakdown
        domain="order"
        entries={[
          { status: "PAID", count: 4 },
          { status: "PAYMENT_MISMATCH", count: 1 },
        ]}
        formatCount={String}
        emphasize={(status) => status === "PAYMENT_MISMATCH"}
      />,
    );

    const bars = container.querySelectorAll("[aria-hidden] > span");
    expect(bars[0]?.className).not.toContain("--danger");
    expect(bars[1]?.className).toContain("--danger");
  });

  it("formats each count through the caller's formatter", () => {
    renderBreakdown(
      <StatusBreakdown
        domain="return"
        entries={[{ status: "REFUNDED", count: 1_204 }]}
        formatCount={(count) => `#${count}#`}
      />,
    );

    expect(screen.getByText("#1204#")).toBeInTheDocument();
  });

  it("draws no bar at all for an empty breakdown, rather than dividing by zero", () => {
    const { container } = renderBreakdown(
      <StatusBreakdown domain="return" entries={[]} formatCount={String} />,
    );

    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});
