import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";

import { ProductReorderList, type ProductReorderRow } from "./product-reorder-list";
import esMessages from "../../../messages/es.json";

/**
 * The catalogue-wide reorder tool.
 *
 * UP/DOWN BUTTONS, NOT DRAG-AND-DROP — see the component's own doc comment
 * for why. What matters here is exactly what a keyboard-only operator gets:
 * a row at either end has its outward move disabled, moving swaps exactly
 * two rows, and the save call sends the WHOLE current order, not a diff.
 */

const t = esMessages.admin.productReorder;

const ROWS: readonly ProductReorderRow[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Creatina", sku: "AK-CRE", imageUrl: null },
  { id: "22222222-2222-4222-8222-222222222222", name: "Magnesio", sku: "AK-MAG", imageUrl: null },
  { id: "33333333-3333-4333-8333-333333333333", name: "Omega-3", sku: "AK-OMG", imageUrl: null },
];

function renderList(
  rows: readonly ProductReorderRow[] = ROWS,
  onSave = vi.fn().mockResolvedValue({ ok: true, data: { reordered: rows.length } }),
) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ProductReorderList initial={rows} onSave={onSave} />
    </NextIntlClientProvider>,
  );
  return { onSave };
}

/** Rows in on-screen order, by name. */
function names(): string[] {
  return screen.getAllByRole("listitem").map((row) => row.textContent ?? "");
}

describe("ProductReorderList", () => {
  it("renders every row in the given order", () => {
    renderList();
    const rendered = names();
    expect(rendered[0]).toContain("Creatina");
    expect(rendered[1]).toContain("Magnesio");
    expect(rendered[2]).toContain("Omega-3");
  });

  it("disables moving the first row up and the last row down", () => {
    renderList();

    expect(screen.getByRole("button", { name: "Subir Creatina" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bajar Omega-3" })).toBeDisabled();
    // Everything else stays enabled.
    expect(screen.getByRole("button", { name: "Bajar Creatina" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Subir Omega-3" })).toBeEnabled();
  });

  it("moving a row down swaps it with its neighbour, nothing else", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "Bajar Creatina" }));

    const rendered = names();
    expect(rendered[0]).toContain("Magnesio");
    expect(rendered[1]).toContain("Creatina");
    expect(rendered[2]).toContain("Omega-3");
  });

  it("moving a row up swaps it with its neighbour, nothing else", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "Subir Omega-3" }));

    const rendered = names();
    expect(rendered[0]).toContain("Creatina");
    expect(rendered[1]).toContain("Omega-3");
    expect(rendered[2]).toContain("Magnesio");
  });

  it("sends the WHOLE current order on save, not a diff", async () => {
    const user = userEvent.setup();
    const { onSave } = renderList();

    await user.click(screen.getByRole("button", { name: "Bajar Creatina" }));
    await user.click(screen.getByRole("button", { name: t.save }));

    expect(onSave).toHaveBeenCalledWith([
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("confirms success without pretending it happened before the save resolved", async () => {
    const user = userEvent.setup();
    renderList();

    expect(screen.queryByText(t.saveSuccess)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t.save }));
    expect(await screen.findByText(t.saveSuccess)).toBeInTheDocument();
  });

  it("surfaces a save failure without claiming success", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({
      ok: false,
      code: "INTERNAL_ERROR",
      reason: null,
      message: "boom",
    });
    renderList(ROWS, onSave);

    await user.click(screen.getByRole("button", { name: t.save }));

    expect(await screen.findByText(t.saveFailed)).toBeInTheDocument();
    expect(screen.queryByText(t.saveSuccess)).not.toBeInTheDocument();
  });

  it("renders an empty state rather than a bare list when there is nothing to reorder", () => {
    renderList([]);
    expect(screen.getByText(t.empty)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
