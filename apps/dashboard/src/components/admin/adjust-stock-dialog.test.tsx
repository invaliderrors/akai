import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";

import esMessages from "../../../messages/es.json";

const { adjustInventoryAction } = vi.hoisted(() => ({
  adjustInventoryAction: vi.fn(),
}));
vi.mock("@/lib/admin/actions", () => ({ adjustInventoryAction }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { AdjustStockDialog } = await import("./adjust-stock-dialog");

const form = esMessages.admin.productForm;

function renderDialog(onHand = 29) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <AdjustStockDialog
        variantId="11111111-1111-4111-8111-111111111111"
        sku="AK-HOOD-M"
        onHand={onHand}
        reserved={4}
      />
    </NextIntlClientProvider>,
  );
}

// Braced, because a hook that RETURNS a value has that value treated as a
// teardown callback — the trap this repo documents at length.
beforeEach(() => {
  adjustInventoryAction.mockReset();
  adjustInventoryAction.mockResolvedValue({ ok: true, data: null });
});

describe("<AdjustStockDialog />", () => {
  it("turns the count an operator typed into the delta the ledger takes", async () => {
    // Counting a shelf produces "there are 37", never "add 8". The conversion is
    // the whole reason this dialog exists rather than a raw delta box.
    const user = userEvent.setup();
    renderDialog(29);

    await user.click(screen.getByRole("button", { name: form.stock.adjust }));
    const target = screen.getByLabelText(form.stock.targetLabel);
    await user.clear(target);
    await user.type(target, "37");
    await user.click(screen.getByRole("button", { name: form.stock.confirm }));

    expect(adjustInventoryAction).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { delta: 8, reason: "STOCK_COUNT", expectedOnHand: 29 },
    );
  });

  it("counts down as readily as up", async () => {
    const user = userEvent.setup();
    renderDialog(29);

    await user.click(screen.getByRole("button", { name: form.stock.adjust }));
    const target = screen.getByLabelText(form.stock.targetLabel);
    await user.clear(target);
    await user.type(target, "20");
    await user.click(screen.getByRole("button", { name: form.stock.confirm }));

    expect(adjustInventoryAction).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ delta: -9 }),
    );
  });

  it("will not send an adjustment that changes nothing", async () => {
    // `adjustInventoryRequestSchema` refuses a zero delta, and an operator who
    // changed nothing should meet a disabled button rather than a validation
    // error explaining what they did not do.
    const user = userEvent.setup();
    renderDialog(29);

    await user.click(screen.getByRole("button", { name: form.stock.adjust }));

    expect(screen.getByRole("button", { name: form.stock.confirm })).toBeDisabled();
    expect(screen.getByText(form.stock.unchanged)).toBeInTheDocument();
    expect(adjustInventoryAction).not.toHaveBeenCalled();
  });

  it("writes the reason as a stable token, never as the operator's UI language", async () => {
    // The ledger is append-only and an auditor reads it back later. Storing
    // "Recuento físico" would make the record depend on which language the
    // browser happened to be in when the count was taken.
    const user = userEvent.setup();
    renderDialog(29);

    await user.click(screen.getByRole("button", { name: form.stock.adjust }));
    const target = screen.getByLabelText(form.stock.targetLabel);
    await user.clear(target);
    await user.type(target, "30");
    await user.type(screen.getByLabelText(form.stock.noteLabel), "contados en estante");
    await user.click(screen.getByRole("button", { name: form.stock.confirm }));

    expect(adjustInventoryAction).toHaveBeenCalledWith(
      expect.any(String),
      { delta: 1, reason: "STOCK_COUNT: contados en estante", expectedOnHand: 29 },
    );
  });

  it("says so when the adjustment is refused, rather than closing as if it worked", async () => {
    adjustInventoryAction.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      reason: null,
      message: "stale",
    });
    const user = userEvent.setup();
    renderDialog(29);

    await user.click(screen.getByRole("button", { name: form.stock.adjust }));
    const target = screen.getByLabelText(form.stock.targetLabel);
    await user.clear(target);
    await user.type(target, "37");
    await user.click(screen.getByRole("button", { name: form.stock.confirm }));

    expect(await screen.findByText(form.stock.failed)).toBeInTheDocument();
  });

  it("always sends the on-hand count it displayed, so a stale count is refused", async () => {
    // The delta was computed from the number on screen. If an order moved it
    // since, the API must be able to tell — and it can only if it is told what
    // the operator was looking at.
    const user = userEvent.setup();
    renderDialog(0);

    await user.click(screen.getByRole("button", { name: form.stock.adjust }));
    const target = screen.getByLabelText(form.stock.targetLabel);
    await user.clear(target);
    await user.type(target, "12");
    await user.click(screen.getByRole("button", { name: form.stock.confirm }));

    expect(adjustInventoryAction).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ delta: 12, expectedOnHand: 0 }),
    );
  });

  it.each([
    ["CONFLICT", "STOCK_CHANGED", form.stock.errors.STOCK_CHANGED],
    ["OUT_OF_STOCK", "BELOW_RESERVED", form.stock.errors.BELOW_RESERVED],
    ["OUT_OF_STOCK", "NEGATIVE_STOCK", form.stock.errors.NEGATIVE_STOCK],
  ] as const)(
    "names the refusal: %s / %s gets its own sentence",
    async (code, reason, expected) => {
      adjustInventoryAction.mockResolvedValue({
        ok: false,
        code,
        reason,
        message: "Server-authored English that must never be shown.",
      });
      const user = userEvent.setup();
      renderDialog(29);

      await user.click(screen.getByRole("button", { name: form.stock.adjust }));
      const target = screen.getByLabelText(form.stock.targetLabel);
      await user.clear(target);
      await user.type(target, "20");
      await user.click(screen.getByRole("button", { name: form.stock.confirm }));

      expect(await screen.findByText(expected)).toBeInTheDocument();
      expect(screen.queryByText(form.stock.failed)).not.toBeInTheDocument();
      expect(
        screen.queryByText("Server-authored English that must never be shown."),
      ).not.toBeInTheDocument();
    },
  );

  it("falls back to the generic sentence for a reason it does not recognise", async () => {
    adjustInventoryAction.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      reason: "SOMETHING_NEW",
      message: "Server-authored English that must never be shown.",
    });
    const user = userEvent.setup();
    renderDialog(29);

    await user.click(screen.getByRole("button", { name: form.stock.adjust }));
    const target = screen.getByLabelText(form.stock.targetLabel);
    await user.clear(target);
    await user.type(target, "37");
    await user.click(screen.getByRole("button", { name: form.stock.confirm }));

    expect(await screen.findByText(form.stock.failed)).toBeInTheDocument();
  });
});
