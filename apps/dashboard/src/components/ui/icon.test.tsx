import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon, ICON_NAMES, type IconName } from "./icon";

/**
 * The registry test is the point of the registry.
 *
 * A missing or malformed glyph fails silently in the browser — an empty 16px
 * box beside a label, which nobody reports — so every name is rendered here
 * rather than only the handful a screen happens to use.
 */
describe("Icon", () => {
  it.each(ICON_NAMES)("draws %s as stroked path data", (name: IconName) => {
    const { container } = render(<Icon name={name} />);

    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");

    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      // A `d` that is absent or empty renders nothing at all, which is exactly
      // the failure this loop exists to catch.
      expect(path.getAttribute("d")).toMatch(/\S/);
    }
  });

  it("names the set without duplicates", () => {
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  it("is hidden from assistive technology by default", () => {
    const { container } = render(<Icon name="chevron-right" />);

    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    // The default icon accompanies a visible label, so it must contribute no
    // accessible name of its own.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("becomes a named image when a title is supplied", () => {
    render(<Icon name="triangle-alert" title="Pago no coincide" />);

    const image = screen.getByRole("img", { name: "Pago no coincide" });
    expect(image).not.toHaveAttribute("aria-hidden");
  });

  it("inherits colour and draws at the light 1.5 stroke", () => {
    const { container } = render(<Icon name="package" />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveAttribute("fill", "none");
    expect(svg).toHaveAttribute("stroke-width", "1.5");
  });

  it("sizes in pixels, defaulting to the compact 16", () => {
    const { container: compact } = render(<Icon name="user" />);
    expect(compact.querySelector("svg")).toHaveAttribute("width", "16");
    expect(compact.querySelector("svg")).toHaveAttribute("height", "16");

    const { container: comfortable } = render(<Icon name="user" size={20} />);
    expect(comfortable.querySelector("svg")).toHaveAttribute("width", "20");
    expect(comfortable.querySelector("svg")).toHaveAttribute("height", "20");
  });

  it("keeps shrink-0 when the caller adds classes", () => {
    const { container } = render(
      <Icon name="check" className="text-[var(--success-text)]" />,
    );

    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("shrink-0");
    expect(svg).toHaveClass("text-[var(--success-text)]");
  });
});
