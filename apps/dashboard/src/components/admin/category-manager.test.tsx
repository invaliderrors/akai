import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";

import { CategoryManager, type CategoryRow } from "./category-manager";
import esMessages from "../../../messages/es.json";

/**
 * The catalogue's category tree: create, rename, reorder, delete.
 *
 * `product-reorder-list.test.tsx` already covers the up/down mechanics this
 * component shares (boundary rows disabled, a move swaps exactly two rows,
 * the whole order is sent on save) — this suite focuses on what is UNIQUE
 * here: creating a row, renaming one in place, and the delete confirmation's
 * still-assigned conflict.
 */

const t = esMessages.admin.categoryManager;

const ROWS: readonly CategoryRow[] = [
  { id: "11111111-1111-4111-8111-111111111111", slug: "recuperacion", name: { es: "Recuperación", en: "Recovery" }, productCount: 4 },
  { id: "22222222-2222-4222-8222-222222222222", slug: "rendimiento", name: { es: "Rendimiento", en: "Performance" }, productCount: 0 },
];

function renderManager(rows: readonly CategoryRow[] = ROWS, overrides: Partial<{
  onCreate: ReturnType<typeof vi.fn>;
  onRename: ReturnType<typeof vi.fn>;
  onReorder: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
}> = {}) {
  const onCreate =
    overrides.onCreate ??
    vi.fn().mockResolvedValue({
      ok: true,
      data: { id: "new-cat", slug: "sudaderas", name: { es: "Sudaderas", en: "Hoodies" } },
    });
  const onRename =
    overrides.onRename ??
    vi.fn().mockResolvedValue({
      ok: true,
      data: { id: ROWS[0]?.id, slug: "recuperacion", name: { es: "Recuperación total", en: "Full recovery" } },
    });
  const onReorder = overrides.onReorder ?? vi.fn().mockResolvedValue({ ok: true, data: { reordered: rows.length } });
  const onDelete = overrides.onDelete ?? vi.fn().mockResolvedValue({ ok: true, data: null });

  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <CategoryManager initial={rows} onCreate={onCreate} onRename={onRename} onReorder={onReorder} onDelete={onDelete} />
    </NextIntlClientProvider>,
  );

  return { onCreate, onRename, onReorder, onDelete };
}

function names(): string[] {
  return screen.getAllByRole("listitem").map((row) => row.textContent ?? "");
}

describe("CategoryManager", () => {
  it("renders every row in the given order, with its product count", () => {
    renderManager();
    const rendered = names();
    expect(rendered[0]).toContain("Recuperación");
    expect(rendered[0]).toContain("recuperacion");
    expect(rendered[1]).toContain("Rendimiento");
    expect(screen.getByText(/4 productos/)).toBeInTheDocument();
  });

  it("renders the empty state instead of a bare list when there are no categories", () => {
    renderManager([]);
    expect(screen.getByText(t.empty)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  describe("create", () => {
    it("submits the slug and both locale names, then appends the new row", async () => {
      const user = userEvent.setup();
      const { onCreate } = renderManager();

      await user.type(screen.getByLabelText((content) => content.startsWith(t.slugLabel)), "sudaderas");
      await user.type(screen.getByLabelText((content) => content.startsWith(t.nameEsLabel)), "Sudaderas");
      await user.type(screen.getByLabelText((content) => content.startsWith(t.nameEnLabel)), "Hoodies");
      await user.click(screen.getByRole("button", { name: t.create }));

      expect(onCreate).toHaveBeenCalledWith({
        slug: "sudaderas",
        name: { es: "Sudaderas", en: "Hoodies" },
      });
      expect(await screen.findByText("Sudaderas")).toBeInTheDocument();
    });

    it("shows a specific message for a duplicate slug, not the generic failure", async () => {
      const user = userEvent.setup();
      const onCreate = vi.fn().mockResolvedValue({
        ok: false,
        code: "CONFLICT",
        reason: null,
        message: "boom",
      });
      renderManager(ROWS, { onCreate });

      await user.type(screen.getByLabelText((content) => content.startsWith(t.slugLabel)), "recuperacion");
      await user.type(screen.getByLabelText((content) => content.startsWith(t.nameEsLabel)), "Recuperación");
      await user.type(screen.getByLabelText((content) => content.startsWith(t.nameEnLabel)), "Recovery");
      await user.click(screen.getByRole("button", { name: t.create }));

      expect(await screen.findByText(t.duplicateSlug)).toBeInTheDocument();
    });
  });

  describe("rename", () => {
    it("edits a row in place and saves the new names", async () => {
      const user = userEvent.setup();
      const { onRename } = renderManager();

      const rows = screen.getAllByRole("listitem");
      const first = rows[0];
      if (first === undefined) throw new Error("expected a first row");

      await user.click(within(first).getByRole("button", { name: t.renameTrigger }));

      const esInput = within(first).getByLabelText(t.nameEsLabel);
      await user.clear(esInput);
      await user.type(esInput, "Recuperación total");

      await user.click(within(first).getByRole("button", { name: t.saveRename }));

      expect(onRename).toHaveBeenCalledWith(ROWS[0]?.id, {
        name: { es: "Recuperación total", en: "Recovery" },
      });
      expect(await screen.findByText("Recuperación total")).toBeInTheDocument();
    });

    it("cancels without saving anything", async () => {
      const user = userEvent.setup();
      const { onRename } = renderManager();

      const first = screen.getAllByRole("listitem")[0];
      if (first === undefined) throw new Error("expected a first row");

      await user.click(within(first).getByRole("button", { name: t.renameTrigger }));
      await user.click(within(first).getByRole("button", { name: t.cancelRename }));

      expect(onRename).not.toHaveBeenCalled();
      expect(screen.getByText("Recuperación")).toBeInTheDocument();
    });
  });

  describe("reorder", () => {
    it("moving a row down swaps it with its neighbour, and save sends the whole order", async () => {
      const user = userEvent.setup();
      const { onReorder } = renderManager();

      await user.click(screen.getByRole("button", { name: "Bajar Recuperación" }));
      await user.click(screen.getByRole("button", { name: t.saveOrder }));

      expect(onReorder).toHaveBeenCalledWith([ROWS[1]?.id, ROWS[0]?.id]);
    });

    it("disables moving the first row up and the last row down", () => {
      renderManager();
      expect(screen.getByRole("button", { name: "Subir Recuperación" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Bajar Rendimiento" })).toBeDisabled();
    });
  });

  describe("delete", () => {
    it("removes the row once the type-to-confirm dialog succeeds", async () => {
      const user = userEvent.setup();
      const { onDelete } = renderManager();

      const first = screen.getAllByRole("listitem")[0];
      if (first === undefined) throw new Error("expected a first row");

      await user.click(within(first).getByRole("button", { name: t.deleteTrigger }));
      await user.type(screen.getByLabelText(/Escribe/), ROWS[0]?.slug ?? "");
      await user.click(screen.getByRole("button", { name: t.deleteConfirm }));

      expect(onDelete).toHaveBeenCalledWith(ROWS[0]?.id);
      expect(await screen.findByText("Rendimiento")).toBeInTheDocument();
      expect(screen.queryByText("Recuperación")).not.toBeInTheDocument();
    });

    it("surfaces the still-assigned conflict instead of silently removing the row", async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn().mockResolvedValue({
        ok: false,
        code: "CONFLICT",
        reason: null,
        message: "boom",
      });
      renderManager(ROWS, { onDelete });

      const first = screen.getAllByRole("listitem")[0];
      if (first === undefined) throw new Error("expected a first row");

      await user.click(within(first).getByRole("button", { name: t.deleteTrigger }));
      await user.type(screen.getByLabelText(/Escribe/), ROWS[0]?.slug ?? "");
      await user.click(screen.getByRole("button", { name: t.deleteConfirm }));

      expect(await screen.findByText(t.deleteConflict)).toBeInTheDocument();
      expect(screen.getByText("Recuperación")).toBeInTheDocument();
    });
  });
});
