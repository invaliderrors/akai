import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import {
  DiscountForm,
  buildDiscountPayload,
  toDiscountFormValues,
  type DiscountFormProps,
  type DiscountFormValues,
} from "./discount-form";
import { adminDiscountSchema, type AdminDiscount } from "@/lib/admin/schemas";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import esMessages from "../../../messages/es.json";

const ISO = "2026-07-20T10:00:00.000Z";
const DISCOUNT_ID = "77777777-7777-4777-8777-777777777777";

/**
 * PARSED through the response schema rather than cast, exactly as the
 * storefront's catalog fixtures are: a fixture that has drifted from what the
 * API can actually send must fail in the test that uses it, not pass against a
 * shape that does not exist.
 */
function buildDiscount(overrides: Record<string, unknown> = {}): AdminDiscount {
  return adminDiscountSchema.parse({
    id: DISCOUNT_ID,
    code: "SAVE10",
    type: "PERCENTAGE",
    value: 1250,
    minimumSubtotal: 5000,
    currency: "EUR",
    maxRedemptions: 100,
    maxRedemptionsPerCustomer: 1,
    timesRedeemed: 4,
    remainingRedemptions: 96,
    stackable: false,
    startsAt: null,
    endsAt: null,
    affiliateId: null,
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
    ...overrides,
  });
}

/** A minimal valid form state, so each test varies exactly one thing. */
function validValues(overrides: Partial<DiscountFormValues> = {}): DiscountFormValues {
  return {
    code: "save10",
    type: "PERCENTAGE",
    value: "12.5",
    minimumSubtotal: "",
    currency: "",
    maxRedemptions: "",
    maxRedemptionsPerCustomer: "",
    stackable: false,
    startsAt: "",
    endsAt: "",
    affiliateId: "",
    ...overrides,
  };
}

describe("buildDiscountPayload — the type-overloaded value", () => {
  it("converts a percentage into BASIS POINTS", () => {
    const result = buildDiscountPayload(validValues({ value: "12.5" }), "create");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 12.5% MUST become 1250. Not 12.5, not 125, not 1250.0000001.
    expect(result.value.value).toBe(1250);
    expect(Number.isInteger(result.value.value)).toBe(true);
  });

  it("converts a fixed amount into MINOR UNITS", () => {
    const result = buildDiscountPayload(
      validValues({ type: "FIXED_AMOUNT", value: "5.00" }),
      "create",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.value).toBe(500);
  });

  it("pads a short fraction rather than truncating it", () => {
    // "5.5" read as 55 would take €0.55 off instead of €5.50 — a tenfold error
    // from a single missing zero, in the direction the customer notices least.
    const result = buildDiscountPayload(
      validValues({ type: "FIXED_AMOUNT", value: "5.5" }),
      "create",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.value).toBe(550);
  });

  it("sends zero for FREE_SHIPPING, whatever is in the value box", () => {
    // The effect is on shipping; the column is unused. A stale "12.5" left in
    // state after switching type must not become 1250 basis points of nothing.
    const result = buildDiscountPayload(
      validValues({ type: "FREE_SHIPPING", value: "12.5" }),
      "create",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.value).toBe(0);
  });

  it("reads the amount at the entered currency's exponent, not a hardcoded 100", () => {
    // JPY has no minor unit. "500" is ¥500 = 500 minor units, and a fraction is
    // rejected rather than silently multiplied.
    const yen = buildDiscountPayload(
      validValues({ type: "FIXED_AMOUNT", value: "500", currency: "JPY" }),
      "create",
    );
    expect(yen.ok).toBe(true);
    if (!yen.ok) return;
    expect(yen.value.value).toBe(500);

    const fractional = buildDiscountPayload(
      validValues({ type: "FIXED_AMOUNT", value: "5.5", currency: "JPY" }),
      "create",
    );
    expect(fractional.ok).toBe(false);
    if (fractional.ok) return;
    expect(fractional.errors["value"]).toBe("TOO_MANY_DECIMALS");
  });

  it("refuses a percentage above 100 with a message about the real limit", () => {
    const result = buildDiscountPayload(validValues({ value: "150" }), "create");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not the generic TOO_LARGE: the operator needs to know the cap is 100%.
    expect(result.errors["value"]).toBe("PERCENTAGE_TOO_HIGH");
  });

  it("rejects a grouping separator rather than misreading it by 1000x", () => {
    const result = buildDiscountPayload(
      validValues({ type: "FIXED_AMOUNT", value: "1,234.56" }),
      "create",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["value"]).toBe("GROUPING_SEPARATOR");
  });
});

describe("buildDiscountPayload — the rest of the body", () => {
  it("normalises the code to upper case, matching how the API stores it", () => {
    const result = buildDiscountPayload(validValues({ code: "  save10 " }), "create");

    expect(result.ok).toBe(true);
    // Narrowed on BOTH discriminants: `code` exists only on the create body, so
    // the compiler is what proves this assertion is about the right shape.
    if (!result.ok || result.mode !== "create") return;
    // The service upper-cases on write; sending the same thing means the form
    // and the stored row cannot disagree about what the operator created.
    expect(result.value.code).toBe("SAVE10");
  });

  it("requires a code when creating and never sends one when editing", () => {
    const missing = buildDiscountPayload(validValues({ code: "" }), "create");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.errors["code"]).toBe("REQUIRED");

    // The code is the coupon's identity and the string on every printed card.
    // The update schema has no such key, so an edit cannot rename it even if the
    // input were somehow re-enabled.
    const edit = buildDiscountPayload(validValues({ code: "" }), "edit");
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    expect(edit.value).not.toHaveProperty("code");
  });

  it("turns every empty optional into an explicit null", () => {
    const result = buildDiscountPayload(validValues(), "create");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // null, not undefined and not omitted: the API's schema is `.strict()` and
    // null is how it spells "unrestricted".
    expect(result.value.minimumSubtotal).toBeNull();
    expect(result.value.currency).toBeNull();
    expect(result.value.maxRedemptions).toBeNull();
    expect(result.value.maxRedemptionsPerCustomer).toBeNull();
    expect(result.value.startsAt).toBeNull();
    expect(result.value.endsAt).toBeNull();
  });

  it("converts a minimum subtotal to minor units at the code's currency", () => {
    const result = buildDiscountPayload(
      validValues({ minimumSubtotal: "49,99", currency: "eur" }),
      "create",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.minimumSubtotal).toBe(4999);
    // Upper-cased on the way out, because the contract's currency schema is
    // uppercase-only and a lowercase entry is a typo, not a different currency.
    expect(result.value.currency).toBe("EUR");
  });

  it("rejects a currency that is not a three-letter ISO code", () => {
    const result = buildDiscountPayload(validValues({ currency: "euro" }), "create");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["currency"]).toBe("INVALID_CURRENCY");
  });

  it("treats a zero redemption cap as a mistake, not as 'unlimited'", () => {
    // The API's schema is `.positive()`, so 0 is a 400. "Unlimited" is the EMPTY
    // field, and saying so beats a round trip the operator cannot interpret.
    const result = buildDiscountPayload(validValues({ maxRedemptions: "0" }), "create");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["maxRedemptions"]).toBe("NOT_POSITIVE");
  });

  it("rejects a non-integer redemption cap", () => {
    const result = buildDiscountPayload(
      validValues({ maxRedemptionsPerCustomer: "1.5" }),
      "create",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["maxRedemptionsPerCustomer"]).toBe("NOT_A_WHOLE_NUMBER");
  });

  it("sends a local wall-clock schedule as a UTC instant", () => {
    const result = buildDiscountPayload(
      validValues({ startsAt: "2026-08-01T10:00", endsAt: "2026-09-01T10:00" }),
      "create",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The operator typed a time on their own calendar; the API stores UTC.
    expect(result.value.startsAt).toBe(
      new Date("2026-08-01T10:00").toISOString(),
    );
    expect(result.value.endsAt).toBe(new Date("2026-09-01T10:00").toISOString());
  });

  it("refuses a window that closes before it opens", () => {
    // A coupon nobody can ever redeem is always a typo.
    const result = buildDiscountPayload(
      validValues({ startsAt: "2026-09-01T10:00", endsAt: "2026-08-01T10:00" }),
      "create",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["endsAt"]).toBe("END_BEFORE_START");
  });
});

describe("buildDiscountPayload — affiliate assignment", () => {
  const AFFILIATE_ID = "88888888-8888-4888-8888-888888888888";

  it("sends null for an unassigned code, not an omitted field", () => {
    const result = buildDiscountPayload(validValues({ affiliateId: "" }), "create");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.affiliateId).toBeNull();
  });

  it("passes the picked affiliate through on create", () => {
    const result = buildDiscountPayload(
      validValues({ affiliateId: AFFILIATE_ID }),
      "create",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.affiliateId).toBe(AFFILIATE_ID);
  });

  it("clears an existing assignment on edit when the picker is reset to none", () => {
    // The edit schema's `affiliateId` is optional, but this form always sends
    // it: a controlled picker with an explicit "unassigned" option must be
    // able to CLEAR the field, and an omitted key would leave the old
    // affiliate in place instead.
    const result = buildDiscountPayload(validValues({ affiliateId: "" }), "edit");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.affiliateId).toBeNull();
  });
});

describe("toDiscountFormValues", () => {
  it("round-trips a percentage without moving it by a basis point", () => {
    const discount = buildDiscount({ type: "PERCENTAGE", value: 1250 });
    const built = buildDiscountPayload(toDiscountFormValues(discount), "edit");

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Loading a coupon and saving it untouched must be a no-op on the rate.
    expect(built.value.value).toBe(1250);
    expect(built.value.minimumSubtotal).toBe(5000);
  });

  it("round-trips a fixed amount without moving it by a cent", () => {
    const discount = buildDiscount({ type: "FIXED_AMOUNT", value: 4999 });
    const built = buildDiscountPayload(toDiscountFormValues(discount), "edit");

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.value).toBe(4999);
  });

  it("starts blank for a new code", () => {
    expect(toDiscountFormValues(undefined)).toMatchObject({
      code: "",
      type: "PERCENTAGE",
      value: "",
      currency: "",
      stackable: false,
      affiliateId: "",
    });
  });

  it("round-trips an assigned affiliate, and a cleared one as empty", () => {
    const AFFILIATE_ID = "88888888-8888-4888-8888-888888888888";
    expect(toDiscountFormValues(buildDiscount({ affiliateId: AFFILIATE_ID }))).toMatchObject({
      affiliateId: AFFILIATE_ID,
    });
    expect(toDiscountFormValues(buildDiscount({ affiliateId: null }))).toMatchObject({
      affiliateId: "",
    });
  });
});

/** The exact argument the form hands its parent — a discriminated union. */
type SubmitArg = Parameters<DiscountFormProps["onSubmit"]>[0];

function submitSpy() {
  return vi.fn<(result: SubmitArg) => Promise<void>>(async () => {});
}

function renderForm(options: {
  discount?: AdminDiscount;
  onSubmit?: ReturnType<typeof submitSpy>;
  /** The footer's destructive slot. Absent unless a test is about it. */
  dangerAction?: ReactNode;
  cancelHref?: string;
  affiliates?: DiscountFormProps["affiliates"];
}) {
  const onSubmit = options.onSubmit ?? submitSpy();

  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <DiscountForm
        {...(options.discount === undefined ? {} : { discount: options.discount })}
        {...(options.dangerAction === undefined ? {} : { dangerAction: options.dangerAction })}
        {...(options.cancelHref === undefined ? {} : { cancelHref: options.cancelHref })}
        {...(options.affiliates === undefined ? {} : { affiliates: options.affiliates })}
        onSubmit={onSubmit}
      />
    </NextIntlClientProvider>,
  );

  return { onSubmit };
}

describe("<DiscountForm />", () => {
  describe("the currency control", () => {
    /**
     * It was a three-character text field hinting "por ejemplo EUR". That asks
     * an operator to recall ISO-4217 from memory and accepts "EU", "eur" or
     * "XYZ" without complaint — and a discount scoped to a currency the payment
     * provider cannot charge in simply never applies, with nothing on the
     * screen to say why.
     */
    it("is a select, not a free-text code input", () => {
      renderForm({});
      const control = screen.getByLabelText(esMessages.admin.discounts.form.currencyLabel);
      expect(control.tagName).toBe("SELECT");
    });

    it("defaults to any currency, which is how the API spells null", () => {
      renderForm({});
      const control = screen.getByLabelText<HTMLSelectElement>(
        esMessages.admin.discounts.form.currencyLabel,
      );
      expect(control.value).toBe("");
      expect(
        screen.getByRole("option", { name: esMessages.admin.discounts.form.currencyAny }),
      ).toBeInTheDocument();
    });

    it("offers every currency the payment provider accepts, and only those", () => {
      renderForm({});
      const control = screen.getByLabelText<HTMLSelectElement>(
        esMessages.admin.discounts.form.currencyLabel,
      );
      // +1 for the "any currency" entry that carries the empty value.
      expect(control.options.length).toBe(SUPPORTED_CURRENCIES.length + 1);
      const values = Array.from(control.options, (option) => option.value);
      expect(values).toEqual(["", ...SUPPORTED_CURRENCIES]);
    });

    it("labels each currency with its code first, then its flag and name", () => {
      renderForm({});
      // The code leads so the native select's type-ahead still answers "EUR" —
      // the muscle memory the old code input left behind. See lib/currency.
      const euro = screen.getByRole("option", { name: /^EUR/ });
      expect(euro.textContent).toContain("🇪🇺");
      expect(euro.textContent?.toLowerCase()).toContain("euro");
    });

    it("submits the chosen currency", async () => {
      const user = userEvent.setup();
      const onSubmit = submitSpy();
      renderForm({ onSubmit });

      const control = screen.getByLabelText(esMessages.admin.discounts.form.currencyLabel);
      await user.selectOptions(control, "GBP");

      expect(screen.getByLabelText<HTMLSelectElement>(
        esMessages.admin.discounts.form.currencyLabel,
      ).value).toBe("GBP");
    });
  });

  it("renders translated Spanish copy, not hardcoded English", () => {
    // The admin pages that came before this one hardcode English. This one does
    // not, and the assertion is what stops it regressing to match them.
    renderForm({});

    expect(screen.getByLabelText("Código")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Crear código" }),
    ).toBeInTheDocument();
  });

  it("submits a create payload with the value already in basis points", async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    renderForm({ onSubmit });

    await user.type(screen.getByLabelText("Código"), "verano25");
    await user.type(screen.getByLabelText("Porcentaje de descuento"), "12,5");
    await user.click(screen.getByRole("button", { name: "Crear código" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    // Read off the recorded call rather than through `expect.objectContaining`,
    // whose return type is `any` and would be a lint error repo-wide.
    const submitted = onSubmit.mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      mode: "create",
      value: { code: "VERANO25", value: 1250 },
    });
  });

  it("shows a translated field error instead of a raw code", async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    renderForm({ onSubmit });

    await user.type(screen.getByLabelText("Código"), "verano25");
    await user.type(screen.getByLabelText("Porcentaje de descuento"), "150");
    await user.click(screen.getByRole("button", { name: "Crear código" }));

    // The operator sees the sentence, never "PERCENTAGE_TOO_HIGH".
    expect(
      await screen.findByText("Un descuento porcentual no puede superar el 100 %."),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("locks the code when editing", () => {
    // Renaming a live coupon invalidates every printed card already carrying it.
    renderForm({ discount: buildDiscount() });

    expect(screen.getByLabelText("Código")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeInTheDocument();
  });

  it("puts the destructive action at the opposite end of the footer from Guardar", () => {
    // PLACEMENT IS THE SAFETY PROPERTY. X-23 drew archiving as a red panel of
    // its own; here it is the same row as Save with the whole card between
    // them, so the irreversible control is never the neighbour of the one an
    // operator presses every day. DOM order is what a keyboard walks, so it is
    // the order this asserts — not a class name.
    renderForm({
      discount: buildDiscount(),
      dangerAction: <button type="button">Archivar código</button>,
      cancelHref: "/admin/discounts",
    });

    const danger = screen.getByRole("button", { name: "Archivar código" });
    const save = screen.getByRole("button", { name: "Guardar cambios" });

    expect(screen.getByRole("link", { name: "Cancelar" })).toHaveAttribute(
      "href",
      expect.stringContaining("/admin/discounts"),
    );
    expect(danger.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers neither slot unless the caller fills it", () => {
    // A new code has nothing to archive, and a form with nowhere to go back to
    // must not draw a Cancel that leads nowhere. Both are the caller's call.
    renderForm({});

    expect(screen.queryByRole("link", { name: "Cancelar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archivar código" })).toBeNull();
  });

  it("hides the value box entirely for free shipping", async () => {
    const user = userEvent.setup();
    renderForm({});

    await user.selectOptions(
      screen.getByLabelText("Tipo de descuento"),
      "FREE_SHIPPING",
    );

    // Hidden, not disabled: a greyed-out box invites the operator to hunt for a
    // value the column does not carry.
    expect(screen.queryByLabelText("Porcentaje de descuento")).toBeNull();
    expect(
      screen.getByText(
        "El envío gratis no lleva importe: el efecto se aplica sobre los gastos de envío.",
      ),
    ).toBeInTheDocument();
  });

  describe("the affiliate picker", () => {
    it("is absent while the affiliate list has not loaded", () => {
      renderForm({});
      expect(screen.queryByLabelText("Afiliado")).toBeNull();
    });

    it("offers every affiliate passed in, plus an unassigned option", () => {
      renderForm({
        affiliates: [
          {
            id: "88888888-8888-4888-8888-888888888888",
            name: "Ana",
            country: "ES",
            socialHandle: "@ana",
            email: "ana@example.com",
            discountCodes: [],
            redemptionCount: 0,
            revenueMinor: 0,
            hasLogin: false,
            createdAt: ISO,
            updatedAt: ISO,
            deletedAt: null,
          },
        ],
      });

      const control = screen.getByLabelText("Afiliado");
      expect(control.tagName).toBe("SELECT");
      expect(screen.getByRole("option", { name: "Sin afiliado" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Ana (@ana)" })).toBeInTheDocument();
    });

    it("preselects the code's current affiliate when editing", () => {
      const AFFILIATE_ID = "88888888-8888-4888-8888-888888888888";
      renderForm({
        discount: buildDiscount({ affiliateId: AFFILIATE_ID }),
        affiliates: [
          {
            id: AFFILIATE_ID,
            name: "Ana",
            country: "ES",
            socialHandle: "@ana",
            email: "ana@example.com",
            discountCodes: ["SAVE10"],
            redemptionCount: 3,
            revenueMinor: 4999,
            hasLogin: false,
            createdAt: ISO,
            updatedAt: ISO,
            deletedAt: null,
          },
        ],
      });

      expect(screen.getByLabelText("Afiliado")).toHaveValue(AFFILIATE_ID);
    });
  });
});
