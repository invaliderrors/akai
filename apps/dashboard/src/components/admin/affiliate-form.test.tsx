import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import {
  AffiliateForm,
  buildAffiliatePayload,
  toAffiliateFormValues,
  type AffiliateFormProps,
  type AffiliateFormValues,
} from "./affiliate-form";
import { adminAffiliateSchema, type AdminAffiliate } from "@/lib/admin/schemas";
import esMessages from "../../../messages/es.json";

const ISO = "2026-07-20T10:00:00.000Z";
const AFFILIATE_ID = "88888888-8888-4888-8888-888888888888";

/**
 * PARSED through the response schema rather than cast — same reasoning
 * `discount-form.test.tsx`'s identical fixture gives: a fixture that has
 * drifted from what the API can actually send must fail in the test that uses
 * it, not pass against a shape that does not exist.
 */
function buildAffiliate(overrides: Record<string, unknown> = {}): AdminAffiliate {
  return adminAffiliateSchema.parse({
    id: AFFILIATE_ID,
    name: "Ana",
    country: "ES",
    socialHandle: "@ana",
    email: "ana@example.com",
    discountCodes: ["SAVE10"],
    redemptionCount: 3,
    revenueMinor: 14997,
    hasLogin: false,
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
    ...overrides,
  });
}

function validValues(overrides: Partial<AffiliateFormValues> = {}): AffiliateFormValues {
  return {
    name: "Ana",
    country: "ES",
    socialHandle: "@ana",
    email: "ana@example.com",
    ...overrides,
  };
}

describe("buildAffiliatePayload", () => {
  it("trims and upper-cases the country code", () => {
    const result = buildAffiliatePayload(
      validValues({ name: " Ana ", country: "es" }),
      "create",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("Ana");
    expect(result.value.country).toBe("ES");
  });

  it("requires every field on create", () => {
    const result = buildAffiliatePayload(validValues({ name: "" }), "create");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["name"]).toBe("REQUIRED");
  });

  it("refuses a country code that is not two letters", () => {
    const result = buildAffiliatePayload(validValues({ country: "ESP" }), "create");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["country"]).toBe("INVALID_COUNTRY");
  });

  it("catches a malformed email through the shared schema", () => {
    const result = buildAffiliatePayload(
      validValues({ email: "not-an-email" }),
      "create",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["email"]).toBe("INVALID_EMAIL");
  });

  it("builds an edit payload with every field, not a partial diff", () => {
    const result = buildAffiliatePayload(validValues(), "edit");

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode !== "edit") return;
    expect(result.value).toEqual({
      name: "Ana",
      country: "ES",
      socialHandle: "@ana",
      email: "ana@example.com",
    });
  });
});

describe("toAffiliateFormValues", () => {
  it("starts blank for a new affiliate", () => {
    expect(toAffiliateFormValues(undefined)).toEqual({
      name: "",
      country: "",
      socialHandle: "",
      email: "",
    });
  });

  it("round-trips an existing affiliate", () => {
    expect(toAffiliateFormValues(buildAffiliate())).toEqual({
      name: "Ana",
      country: "ES",
      socialHandle: "@ana",
      email: "ana@example.com",
    });
  });
});

/** The exact argument the form hands its parent — a discriminated union. */
type SubmitArg = Parameters<AffiliateFormProps["onSubmit"]>[0];

function submitSpy() {
  return vi.fn<(result: SubmitArg) => Promise<void>>(async () => {});
}

function renderForm(options: {
  affiliate?: AdminAffiliate;
  onSubmit?: ReturnType<typeof submitSpy>;
  cancelHref?: string;
}) {
  const onSubmit = options.onSubmit ?? submitSpy();

  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <AffiliateForm
        {...(options.affiliate === undefined ? {} : { affiliate: options.affiliate })}
        {...(options.cancelHref === undefined ? {} : { cancelHref: options.cancelHref })}
        onSubmit={onSubmit}
      />
    </NextIntlClientProvider>,
  );

  return { onSubmit };
}

/**
 * Every field on this form is `required`, so its label carries the shared
 * `<span aria-hidden> *</span>` suffix — the same reasoning
 * `category-manager.test.tsx` gives for its own identical `startsWith`
 * queries: an exact label match would have to include that asterisk text.
 */
function labelStartingWith(text: string): (content: string) => boolean {
  return (content) => content.startsWith(text);
}

describe("<AffiliateForm />", () => {
  it("prefills every field when editing", () => {
    renderForm({ affiliate: buildAffiliate() });

    expect(screen.getByLabelText(labelStartingWith("Nombre"))).toHaveValue("Ana");
    expect(screen.getByLabelText(labelStartingWith("País"))).toHaveValue("ES");
    expect(screen.getByLabelText(labelStartingWith("Usuario o red social"))).toHaveValue("@ana");
    expect(screen.getByLabelText(labelStartingWith("Correo electrónico"))).toHaveValue(
      "ana@example.com",
    );
  });

  it("submits a create payload once every field is filled", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({});

    await user.type(screen.getByLabelText(labelStartingWith("Nombre")), "Ana");
    await user.type(screen.getByLabelText(labelStartingWith("País")), "es");
    await user.type(screen.getByLabelText(labelStartingWith("Usuario o red social")), "@ana");
    await user.type(
      screen.getByLabelText(labelStartingWith("Correo electrónico")),
      "ana@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Crear afiliado" }));

    expect(onSubmit).toHaveBeenCalledWith({
      mode: "create",
      value: { name: "Ana", country: "ES", socialHandle: "@ana", email: "ana@example.com" },
    });
  });

  it("shows the field-level error and never submits an incomplete form", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({});

    await user.click(screen.getByRole("button", { name: "Crear afiliado" }));

    // All four fields are empty and required, so the same message appears
    // once per field.
    expect(await screen.findAllByText("Este campo es obligatorio.")).toHaveLength(4);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("gives the form somewhere for Cancel to go", () => {
    renderForm({ affiliate: buildAffiliate(), cancelHref: "/admin/affiliates" });

    expect(screen.getByRole("link", { name: "Cancelar" })).toHaveAttribute(
      "href",
      "/admin/affiliates",
    );
  });

  it("offers no Cancel link and no archive slot with neither supplied", () => {
    renderForm({});

    expect(screen.queryByRole("link", { name: "Cancelar" })).toBeNull();
  });
});
