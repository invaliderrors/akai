import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { Icon, type IconName } from "./icon";
import { Timeline, type TimelineEntry } from "./timeline";
import esMessages from "../../../messages/es.json";
import enMessages from "../../../messages/en.json";

/**
 * The visibility words come from the closed `internalNote` vocabulary in
 * `lib/status`, so every render needs the real catalogue — a fixture would keep
 * passing after a translator flattened "Solo operadores" into something an
 * operator cannot act on.
 */
function renderTimeline(ui: ReactNode, locale: "es" | "en" = "es") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "es" ? esMessages : enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const NOTE: TimelineEntry = {
  id: "evt-1",
  type: "Nota interna",
  message: "Cliente llamó: quiere la entrega antes del viernes.",
  isInternal: true,
  createdAt: "2026-08-29T09:14:00.000Z",
  timestamp: "29 ago, 09:14",
};

const SHIPPED: TimelineEntry = {
  id: "evt-2",
  type: "Enviado con SEUR",
  message: "Seguimiento SEUR-8841-2209",
  isInternal: false,
  createdAt: "2026-08-29T09:12:00.000Z",
  timestamp: "29 ago, 09:12",
  tone: "progress",
  icon: "truck",
};

const PLACED: TimelineEntry = {
  id: "evt-3",
  type: "Pedido realizado",
  message: "3 artículos · tienda (es)",
  isInternal: false,
  createdAt: "2026-08-28T14:32:00.000Z",
  timestamp: "28 ago, 14:32",
  icon: "shopping-bag",
};

const ENTRIES: readonly TimelineEntry[] = [NOTE, SHIPPED, PLACED];

/**
 * The rail is the one element on the row with no text and no role, so it is
 * found by the shape class that defines it — the same approach `badge.test.tsx`
 * takes for its dot. Reading `className` off the node rather than escaping the
 * brackets into a CSS selector keeps the query legible.
 */
function rails(container: HTMLElement): readonly Element[] {
  return Array.from(container.querySelectorAll("span")).filter((span) =>
    span.className.includes("w-[2px]"),
  );
}

/**
 * Every `<path d>` in the subtree, joined — not the first. lucide draws several
 * glyphs with a shared leading arc, so a first-path comparison reports two
 * different symbols as the same one.
 */
function glyphPath(root: HTMLElement): string {
  const paths = Array.from(root.querySelectorAll("svg path"));
  if (paths.length === 0) throw new Error("no glyph rendered");
  return paths.map((path) => path.getAttribute("d") ?? "").join("|");
}

function referenceGlyph(name: IconName): string {
  const { container, unmount } = render(<Icon name={name} />);
  const d = glyphPath(container);
  unmount();
  return d;
}

describe("<Timeline />", () => {
  it("is an ordered list of list items", () => {
    // `<ol>`, because the events happened in an order and that order is the
    // information. Tailwind's preflight strips the marker, which is why the
    // role is stated explicitly — Safari + VoiceOver drop it from an unstyled
    // list, and a rail of events with no list semantics is a wall of text.
    const { container } = renderTimeline(<Timeline entries={ENTRIES} label="Actividad" />);

    const list = screen.getByRole("list", { name: "Actividad" });
    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(container.querySelector("ul")).toBeNull();
  });

  it("distinguishes an internal note BY TEXT, not by colour alone", () => {
    /*
     * The defect this component exists to close: today both halves render
     * identically, so the only thing between an internal note and a customer
     * reply is the operator remembering which line they typed. Colour cannot
     * carry that (WCAG 1.4.1, and a printed picking list has no colour at
     * all) — the words have to be in the accessible tree.
     */
    renderTimeline(<Timeline entries={ENTRIES} />);

    expect(screen.getByText("Solo operadores")).toBeInTheDocument();
    expect(screen.getAllByText("Visible para el cliente")).toHaveLength(2);
  });

  it("translates the visibility words, and only those", () => {
    // The API's `type` and `message` are open `z.string()` with no enum behind
    // them, so they are rendered verbatim in both locales. The two visibility
    // labels are ours, and they move.
    renderTimeline(<Timeline entries={[NOTE, SHIPPED]} />, "en");

    expect(screen.getByText("Operators only")).toBeInTheDocument();
    expect(screen.getByText("Visible to customer")).toBeInTheDocument();
    expect(screen.getByText(/Cliente llamó/)).toBeInTheDocument();
    expect(screen.getByText("Enviado con SEUR")).toBeInTheDocument();
  });

  it("gives the internal note its own card, glyph and ink", () => {
    const { container } = renderTimeline(<Timeline entries={ENTRIES} />);

    const [first] = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(first).toBeDefined();

    const card = first?.querySelector("div.bg-\\[var\\(--warning-fill\\)\\]");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Solo operadores");

    // Exactly one warning-tinted card, so a customer-visible event cannot pick
    // up the treatment that means "do not paste this to anyone".
    expect(container.querySelectorAll("div.bg-\\[var\\(--warning-fill\\)\\]")).toHaveLength(1);
  });

  it("forces the internal treatment even when the caller asks for another", () => {
    // The safety property is not a default. A call site that passed
    // `tone="success"` on a note — or reused one entry shape for both kinds —
    // must not be able to make it look like a shipping confirmation.
    const { container } = renderTimeline(
      <Timeline entries={[{ ...NOTE, tone: "success", icon: "truck" }]} />,
    );

    expect(screen.getByText("Solo operadores")).toBeInTheDocument();
    expect(container.querySelector("span.bg-\\[var\\(--success-fill\\)\\]")).toBeNull();
    expect(container.querySelector("span.bg-\\[var\\(--warning-fill\\)\\]")).not.toBeNull();

    // The glyph itself, not merely "an svg is present": `truck` and `lock` both
    // render a path, so a presence check would pass on the wrong one — and the
    // wrong one here is a note dressed as a shipping confirmation.
    expect(glyphPath(container)).toBe(referenceGlyph("lock"));
  });

  it("omits the rail on the last entry", () => {
    // A rail running past the last node promises an event that is not there.
    const { container } = renderTimeline(<Timeline entries={ENTRIES} />);

    expect(rails(container)).toHaveLength(ENTRIES.length - 1);
  });

  it("draws no rail at all for a single entry", () => {
    const { container } = renderTimeline(<Timeline entries={[PLACED]} />);

    expect(rails(container)).toHaveLength(0);
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(1);
  });

  it("carries the machine-readable timestamp beside the human one", () => {
    const { container } = renderTimeline(<Timeline entries={[PLACED]} />);

    const time = container.querySelector("time");
    expect(time).toHaveAttribute("dateTime", "2026-08-28T14:32:00.000Z");
    expect(time?.textContent).toBe("28 ago, 14:32");
    // Mono is for identifiers. A timestamp aligns with `tabular-nums` instead.
    expect(time?.className).toContain("tabular-nums");
    expect(time?.className).not.toContain("font-mono");
  });

  it("points at a heading the caller already rendered", () => {
    renderTimeline(
      <>
        <h2 id="activity-heading">Actividad</h2>
        <Timeline entries={ENTRIES} labelledBy="activity-heading" />
      </>,
    );

    expect(screen.getByRole("list", { name: "Actividad" })).toBeInTheDocument();
  });
});

describe("<Timeline /> composer", () => {
  const COMPOSER = {
    label: "Nota interna",
    submitLabel: "Guardar nota",
    errorMessage: "No se pudo guardar la nota.",
    placeholder: "Añadir nota interna…",
  } as const;

  it("submits the note and clears the field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(note: string) => Promise<void>>().mockResolvedValue(undefined);

    renderTimeline(
      <Timeline entries={ENTRIES} composer={{ ...COMPOSER, onSubmit }} />,
    );

    const field = screen.getByLabelText("Nota interna");
    await user.type(field, "  Llamar al transportista  ");
    await user.click(screen.getByRole("button", { name: "Guardar nota" }));

    // Trimmed: a note that is three spaces is not a note, and the API's
    // `message` is a `z.string()` that would happily store them.
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Llamar al transportista");
    await waitFor(() => {
      expect(field).toHaveValue("");
    });
  });

  it("cannot be submitted empty", async () => {
    const onSubmit = vi.fn();

    renderTimeline(<Timeline entries={ENTRIES} composer={{ ...COMPOSER, onSubmit }} />);

    expect(screen.getByRole("button", { name: "Guardar nota" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the draft and says so when the write fails", async () => {
    /*
     * The operator's typed sentence is the only thing on this screen that
     * cannot be fetched again. Clearing the field on a rejected write would
     * delete it AND tell them it saved — which is why `errorMessage` is a
     * required prop rather than an optional one.
     */
    const user = userEvent.setup();
    const onSubmit = vi.fn<(note: string) => Promise<void>>().mockRejectedValue(new Error("500"));

    renderTimeline(<Timeline entries={ENTRIES} composer={{ ...COMPOSER, onSubmit }} />);

    const field = screen.getByLabelText("Nota interna");
    await user.type(field, "Reembolso acordado por teléfono");
    await user.click(screen.getByRole("button", { name: "Guardar nota" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo guardar la nota.");
    expect(field).toHaveValue("Reembolso acordado por teléfono");
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("is absent unless a composer is supplied", () => {
    renderTimeline(<Timeline entries={ENTRIES} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("names the field even though its label is not drawn", () => {
    // `labelHidden` takes the pixels, never the name: the composer is a single
    // unlabelled box beside a button, which is the shape of every form nobody
    // can fill in with a screen reader.
    renderTimeline(
      <Timeline entries={ENTRIES} composer={{ ...COMPOSER, onSubmit: vi.fn() }} />,
    );

    expect(screen.getByLabelText("Nota interna")).toHaveAttribute(
      "placeholder",
      "Añadir nota interna…",
    );
  });
});
