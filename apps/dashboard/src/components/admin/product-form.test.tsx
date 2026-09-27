import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toMinor, type CurrencyCode, type Product } from "@akai/contracts";

import type { StagedImage } from "@/components/ui/media-uploader";
import { ToastProvider } from "@/components/ui/toast";

import {
  ProductForm,
  TranslateCopyError,
  buildPayload,
  classifyVariantChanges,
  tierPercent,
  tierPriceFromPercent,
  productCopySchema,
  stagedVariantImages,
  toFormValues,
  type ProductCopyDraft,
  type ProductFormMessages,
  type TranslateCopyRequest,
  type SizeUnit,
} from "./product-form";
import type { AddOnCandidate } from "./add-on-picker";
import type { PackComponentCandidate } from "./pack-components-picker";
import esMessages from "../../../messages/es.json";

// The variant image control reaches `MediaUploader`, which refreshes the server
// page after a write. Only the tests that pass `variantImages` render it.
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const EUR = "EUR" as CurrencyCode;
const ISO = "2026-07-20T10:00:00.000Z";

const form = esMessages.admin.productForm;
const variantImage = esMessages.admin.variantImage;

/** The copy panel's two segments, named as the operator sees them. */
const SPANISH = /Español/;
const ENGLISH = /English/;

/**
 * The translated copy the pure builder needs, taken from the REAL catalogue.
 *
 * `buildPayload` takes its messages as an argument precisely so it can stay a
 * pure function with no provider — and reading them from `es.json` here rather
 * than retyping them means a reworded price error fails this file instead of
 * quietly diverging from what an operator actually reads.
 */
const messages: ProductFormMessages = {
  money: esMessages.admin.common.moneyErrors,
  compareAtTooLow: form.fieldErrors.COMPARE_AT_TOO_LOW,
  notAWholeNumber: form.fieldErrors.NOT_A_WHOLE_NUMBER,
  notWholeGrams: form.fieldErrors.NOT_WHOLE_GRAMS,
  sizeRequired: "size required",
  sizeDuplicate: "size duplicate",
  sizeNotANumber: "size not a number",
  tierQuantityInvalid: "tier quantity invalid",
  tierDuplicate: "tier duplicate",
  tierPriceTooHigh: "tier price too high",
};

function buildProduct(): Product {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "bpc-157",
    status: "ACTIVE",
    taxClass: "STANDARD",
    translations: [
      {
        locale: "es",
        name: "BPC-157",
        shortDescription: "Péptido",
        description: "Descripción",
      },
    ],
    variants: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        productId: "22222222-2222-4222-8222-222222222222",
        sku: "AK-BPC-10",
        name: { es: "10 mg", en: "10 mg" },
        // CONSISTENT WITH `name`, deliberately: real stored data always sets
        // the two together (`buildPayload`'s own `options`/`name` pair, below)
        // — a fixture that left this `{}` while `name` implies a size would
        // make `classifyVariantChanges` see a changed size on every untouched
        // round-trip, which is a fixture bug, not a real one.
        options: { size: "10 mg" },
        price: {
          currency: EUR,
          net: toMinor(4132),
          tax: toMinor(867),
          gross: toMinor(4999),
          compareAtGross: toMinor(5999),
          taxRateBps: 2100,
        },
        priceTiers: [],
        weightGrams: 20,
        inventory: {
          variantId: "11111111-1111-4111-8111-111111111111",
          onHand: 12,
          reserved: 2,
          available: 10,
          lowStockThreshold: 5,
          allowBackorder: false,
        },
        batch: null,
        image: null,
        isActive: true,
        version: 3,
      },
    ],
    media: [],
    categories: [],
    addOns: [],
    kind: "SIMPLE",
    packComponents: [],
    form: "LYOPHILIZED",
    showCoa: false,
    coaUrl: null,
    restrictedCountries: [],
    listed: true,
    offerOnNewProducts: false,
    newProductDefaultVariantId: null,
    stackDiscountEnabled: false,
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
  };
}

/**
 * Build a form state whose single variant carries `overrides`.
 *
 * Exists so no test has to index into `values.variants[0]` — under
 * `noUncheckedIndexedAccess` that is `T | undefined`, and the obvious fix (`!`)
 * is banned repo-wide. Threading the override through the fixture keeps both the
 * compiler and the lint rule satisfied without weakening either.
 */
function withVariant(
  overrides: Partial<ReturnType<typeof validValues>["variants"][number]>,
) {
  const values = validValues();
  const [variant, ...rest] = values.variants;

  // Narrowed, not asserted. Without this the spread of a `T | undefined` makes
  // every field optional and the result stops satisfying ProductFormValues —
  // which is exactly what the compiler just caught.
  if (variant === undefined) {
    throw new Error("validValues() must define at least one variant");
  }

  return { ...values, variants: [{ ...variant, ...overrides }, ...rest] };
}

/** A minimal valid form state, so each test varies exactly one thing. */
function validValues() {
  return {
    slug: "bpc-157",
    status: "DRAFT" as const,
    taxClass: "STANDARD" as const,
    listed: true,
    offerOnNewProducts: false,
    newProductDefaultVariantId: null as string | null,
    stackDiscountEnabled: false,
    currency: EUR,
    kind: "SIMPLE" as "SIMPLE" | "PACK",
    form: "LYOPHILIZED" as "LYOPHILIZED" | "SOLUTION" | "CAPSULE" | "OTHER",
    showCoa: false,
    // Annotated structurally, same reasoning as `addOns` immediately below.
    packComponents: [] as readonly { id: string; variantId: string; quantity: number }[],
    // Annotated structurally rather than via an import, exactly as
    // `priceTiers` below is: a bare [] infers as never[], which would make
    // `withVariant`/override helpers a type error the moment a test supplies a
    // real entry.
    addOns: [] as readonly { id: string; defaultVariantId: string | null }[],
    categoryIds: [] as readonly string[],
    translations: [
      {
        locale: "es" as const,
        name: "BPC-157",
        shortDescription: "Péptido",
        description: "Descripción",
      },
      { locale: "en" as const, name: "", shortDescription: "", description: "" },
    ],
    variants: [
      {
        key: "v1",
        version: 3,
        sku: "AK-BPC-10",
        nameEs: "10 mg",
        nameEn: "10 mg",
        // BLANK ON PURPOSE. A filled size overrides the carried name, so seeding
        // one here would quietly rewrite `nameEs`/`nameEn` for every test in the
        // file — including the one that clears them to assert a null name.
        // Annotated for the same reason `stagedImage` is: a bare "" infers as
        // `string`, which is not assignable to `SizeUnit | ""`.
        sizeAmount: "",
        sizeUnit: "" as SizeUnit | "",
        priceGross: "49.99",
        compareAtGross: "",
        weightGrams: "20",
        initialStock: "12",
        lowStockThreshold: "5",
        allowBackorder: false,
        // Annotated rather than left as a bare `null`, which infers the type
        // `null` and makes `withVariant({ stagedImage: … })` — the whole point
        // of that helper — a type error.
        stagedImage: null as StagedImage | null,
        priceTiers: [] as readonly {
          key: string;
          minQuantity: string;
          unitPriceGross: string;
        }[],
      },
    ],
  };
}

/** One tier draft, as the form holds it: both fields are strings as typed. */
function tierDraft(minQuantity: string, unitPriceGross: string) {
  return { key: `t-${minQuantity}`, minQuantity, unitPriceGross };
}

/** A file the operator has picked but nothing has uploaded yet. */
function stagedImage(name: string): StagedImage {
  return {
    file: new File([new Uint8Array(8)], name, { type: "image/png" }),
    previewUrl: `blob:${name}`,
    altEs: "",
    altEn: "",
  };
}

/** Every render needs the provider now: the form reads four namespaces. */
function renderForm(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("buildPayload", () => {
  it("converts a major-unit price into integer minor units", () => {
    const result = buildPayload(validValues(), messages);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 49.99 euros MUST become 4999 cents. Not 49.99, not 4999.0000001.
    expect(result.value.variants[0]?.priceGross).toBe(4999);
    expect(Number.isInteger(result.value.variants[0]?.priceGross)).toBe(true);
  });

  it("submits the operator's category selection, not a hardcoded empty list", () => {
    // §6 of the 2026-09-15 spec: this form used to send `categoryIds: []` on
    // every save, so category assignment silently did nothing from here.
    const result = buildPayload(
      { ...validValues(), categoryIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] },
      messages,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.categoryIds).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });

  it("reports an unparseable price against the price field", () => {
    const result = buildPayload(withVariant({ priceGross: "forty nine" }), messages);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["variants.0.priceGross"]).toBeDefined();
  });

  it("rejects a grouping separator rather than misreading it by 1000x", () => {
    const result = buildPayload(withVariant({ priceGross: "1,234.56" }), messages);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The TRANSLATED message, not the parser's code: what the operator reads is
    // what is asserted, and it comes from the catalogue.
    expect(result.errors["variants.0.priceGross"]).toBe(
      esMessages.admin.common.moneyErrors.GROUPING_SEPARATOR,
    );
  });

  it("treats an empty compare-at as 'no sale price', not as an error", () => {
    const result = buildPayload(validValues(), messages);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.variants[0]?.compareAtGross).toBeNull();
  });

  it("rejects a compare-at below the selling price", () => {
    // A negative discount is an unlawful price display in several EU member
    // states, not merely an odd-looking badge.
    const result = buildPayload(
      withVariant({ priceGross: "49.99", compareAtGross: "39.99" }),
      messages,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["variants.0.compareAtGross"]).toBe(messages.compareAtTooLow);
  });

  it("validates the slug against the contract, not a local copy of the rule", () => {
    const result = buildPayload({ ...validValues(), slug: "Not A Slug" }, messages);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["slug"]).toBeDefined();
  });

  it("drops empty translations rather than sending blank copy", () => {
    // The English fields are untouched in validValues(); sending them as empty
    // strings would publish a product with a blank English name.
    const result = buildPayload(validValues(), messages);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.translations).toHaveLength(1);
    expect(result.value.translations[0]?.locale).toBe("es");
  });

  it("maps a translation error onto its locale, not its array index", () => {
    // "translations.0.name" means nothing to an operator looking at a box under
    // an "Español" heading — and it is also what tells the form which locale to
    // switch to when the rejected copy is the one off screen.
    const values = validValues();
    const result = buildPayload(
      {
        ...values,
        translations: [
          { locale: "es", name: "x".repeat(300), shortDescription: "", description: "" },
          { locale: "en", name: "", shortDescription: "", description: "" },
        ],
      },
      messages,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["translations.es.name"]).toBeDefined();
  });

  it("requires at least one translation", () => {
    const values = validValues();
    const result = buildPayload(
      {
        ...values,
        translations: [
          { locale: "es", name: "", shortDescription: "", description: "" },
          { locale: "en", name: "", shortDescription: "", description: "" },
        ],
      },
      messages,
    );

    expect(result.ok).toBe(false);
  });

  it("sends null rather than {} when a variant has no per-locale name", () => {
    const result = buildPayload(withVariant({ nameEs: "", nameEn: "" }), messages);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.variants[0]?.name).toBeNull();
  });

  it("carries the listing choice to the contract's own flag", () => {
    const listed = buildPayload(validValues(), messages);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.listed).toBe(true);

    // An add-on is ACTIVE and purchasable; it is only out of the index. The
    // flag is the whole difference, so it has to survive the payload.
    const addOn = buildPayload({ ...validValues(), listed: false }, messages);
    expect(addOn.ok).toBe(true);
    if (!addOn.ok) return;
    expect(addOn.value.listed).toBe(false);
  });

  it("sanitises the description, so what the preview drew is what is submitted", () => {
    const values = validValues();
    const result = buildPayload(
      {
        ...values,
        translations: [
          {
            locale: "es",
            name: "BPC-157",
            shortDescription: "Péptido",
            description: '<p onclick="steal()">Perfil</p><script>alert(1)</script>',
          },
          { locale: "en", name: "", shortDescription: "", description: "" },
        ],
      },
      messages,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const description = result.value.translations[0]?.description;
    // The API sanitises again on write, and that copy is the authoritative one.
    // This assertion is about a different property: a form that previews one
    // string and posts another has a sanitiser in name only.
    expect(description).toBe("<p>Perfil</p>");
    expect(description).not.toContain("onclick");
    expect(description).not.toContain("alert");
  });

  it("leaves the summary alone, because it is not parsed as HTML", () => {
    // Escaping is right for the description for exactly the reason it is wrong
    // here: one is parsed as markup, the other is printed as text, and running
    // the summary through the sanitiser would show a customer "10 &lt; 20".
    const values = validValues();
    const result = buildPayload(
      {
        ...values,
        translations: [
          {
            locale: "es",
            name: "BPC-157",
            shortDescription: "10 < 20 mg",
            description: "",
          },
          { locale: "en", name: "", shortDescription: "", description: "" },
        ],
      },
      messages,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.translations[0]?.shortDescription).toBe("10 < 20 mg");
  });
});

describe("productCopySchema", () => {
  /**
   * The guard between a translation handler and three controlled inputs.
   *
   * `TranslateCopy` is typed, but the value it resolves with crossed a network
   * first — and a missing `description` landing `undefined` in a controlled
   * input switches that field to uncontrolled, after which the operator's
   * keystrokes are silently unmanaged. The form parses instead, and shows its
   * own failure message.
   */
  it("rejects a partial payload rather than letting undefined reach an input", () => {
    expect(productCopySchema.safeParse({ name: "BPC-157" }).success).toBe(false);
    expect(
      productCopySchema.safeParse({
        name: "BPC-157",
        shortDescription: "Peptide",
        description: 42,
      }).success,
    ).toBe(false);
  });

  it("accepts the three fields and drops anything extra", () => {
    const parsed = productCopySchema.safeParse({
      name: "BPC-157",
      shortDescription: "Peptide",
      description: "Description",
      // A newer server saying more than we asked for is not a failure.
      detectedSourceLocale: "es",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const copy: ProductCopyDraft = parsed.data;
    expect(copy).toEqual({
      name: "BPC-157",
      shortDescription: "Peptide",
      description: "Description",
    });
  });
});

describe("buildPayload — volume tiers", () => {
  it("converts each tier into integer minor units", () => {
    const result = buildPayload(
      withVariant({ priceTiers: [tierDraft("3", "44.99")] }),
      messages,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.variants[0]?.priceTiers).toEqual([
      { minQuantity: 3, unitPriceGross: 4499 },
    ]);
  });

  it("sends an empty array for a variant with no tiers", () => {
    // Every variant that existed before this feature. The contract defaults the
    // field, so this is what keeps the change additive for them.
    const result = buildPayload(validValues(), messages);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.variants[0]?.priceTiers).toEqual([]);
  });

  it("refuses a tier that starts at 1, which is the base price by definition", () => {
    // `minQuantity >= 2` is a CHECK constraint in the migration; catching it
    // here names the field instead of surfacing an opaque 400 after the save.
    const result = buildPayload(
      withVariant({ priceTiers: [tierDraft("1", "44.99")] }),
      messages,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["variants.0.priceTiers.0.minQuantity"]).toBe(
      messages.tierQuantityInvalid,
    );
  });

  it("refuses a quantity that is not a plain whole number", () => {
    // `Number("5e3")` is 5000 and `Number(" 5 ")` is 5 — neither is what an
    // operator typed into a quantity box.
    const result = buildPayload(
      withVariant({ priceTiers: [tierDraft("5e3", "44.99")] }),
      messages,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["variants.0.priceTiers.0.minQuantity"]).toBe(
      messages.tierQuantityInvalid,
    );
  });

  it("refuses two tiers starting at the same quantity", () => {
    // `(variantId, minQuantity)` is UNIQUE, so the second row is a lost write
    // rather than a second tier.
    const result = buildPayload(
      withVariant({ priceTiers: [tierDraft("5", "44.99"), tierDraft("5", "42.00")] }),
      messages,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["variants.0.priceTiers.1.minQuantity"]).toBe(
      messages.tierDuplicate,
    );
  });

  it("refuses a tier price at or above the unit price", () => {
    // Not a discount. Shown in the shop's volume table it would render as
    // "−0 %", which is a false saving claim rather than a display quirk.
    const result = buildPayload(
      withVariant({ priceTiers: [tierDraft("5", "49.99")] }),
      messages,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["variants.0.priceTiers.0.unitPriceGross"]).toBe(
      messages.tierPriceTooHigh,
    );
  });

  it("reports an unparseable tier price through the money messages", () => {
    const result = buildPayload(
      withVariant({ priceTiers: [tierDraft("5", "forty")] }),
      messages,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["variants.0.priceTiers.0.unitPriceGross"]).toBe(
      messages.money.NOT_A_NUMBER,
    );
  });

  it("sorts tiers on the way out, whatever order they were entered in", () => {
    const result = buildPayload(
      withVariant({
        priceTiers: [tierDraft("10", "39.99"), tierDraft("3", "44.99")],
      }),
      messages,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.variants[0]?.priceTiers.map((tier) => tier.minQuantity)).toEqual([
      3, 10,
    ]);
  });

  it("computes the fixed schedule from the variant's own price when stack discount is on, discarding any submitted tiers", () => {
    const result = buildPayload(
      {
        ...withVariant({ priceTiers: [tierDraft("2", "1.00")] }),
        stackDiscountEnabled: true,
      },
      messages,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 49.99 EUR at -10/-15/-30/-40%.
    expect(result.value.variants[0]?.priceTiers).toEqual([
      { minQuantity: 2, unitPriceGross: 4499 },
      { minQuantity: 3, unitPriceGross: 4249 },
      { minQuantity: 5, unitPriceGross: 3499 },
      { minQuantity: 10, unitPriceGross: 2999 },
    ]);
  });

  it("includes stackDiscountEnabled in the built payload", () => {
    const result = buildPayload({ ...validValues(), stackDiscountEnabled: true }, messages);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stackDiscountEnabled).toBe(true);
  });
});

describe("tier percentages", () => {
  /** The single variant from the standard fixture, narrowed for the compiler. */
  function draft() {
    const variant = validValues().variants[0];
    if (variant === undefined) throw new Error("fixture must define a variant");
    return variant;
  }

  it("derives the discount from the base price and the tier price", () => {
    // 44.99 against a 49.99 base is 10 % off. The percentage is COMPUTED, never
    // stored — `priceTiers` holds the absolute unit price because that is the
    // figure the cart charges.
    expect(tierPercent(draft(), tierDraft("5", "44.99"), EUR)).toBe("10");
    expect(tierPercent(draft(), tierDraft("10", "29.99"), EUR)).toBe("40");
  });

  it("says nothing when there is no base price to measure against", () => {
    // A percentage of nothing is not 0 %, it is not a question.
    const blank = { ...draft(), priceGross: "" };
    expect(tierPercent(blank, tierDraft("5", "44.99"), EUR)).toBe("");
  });

  it("turns a typed percentage into the unit price that will be stored", () => {
    // 10 % off 49.99 is 44.991 -> 4499 minor units. Rounded ONCE, here, so the
    // cart never rounds money at charge time.
    expect(tierPriceFromPercent(draft(), "10", EUR)).toBe("44.99");
    expect(tierPriceFromPercent(draft(), "40", EUR)).toBe("29.99");
  });

  it("round-trips: a derived percent rebuilds the same price", () => {
    const price = tierPriceFromPercent(draft(), "30", EUR);
    expect(price).not.toBeNull();
    if (price === null) return;
    expect(tierPercent(draft(), tierDraft("5", price), EUR)).toBe("30");
  });

  it("refuses a percentage outside 1-99 rather than writing a nonsense price", () => {
    // 100 % is excluded deliberately: a free tier is a price of zero, which the
    // operator types and sees, not something a discount field produces.
    for (const bad of ["0", "100", "-5", "12.5", "abc", ""]) {
      expect(tierPriceFromPercent(draft(), bad, EUR)).toBeNull();
    }
  });

  it("leaves the price alone when the base price cannot be parsed", () => {
    const blank = { ...draft(), priceGross: "forty nine" };
    expect(tierPriceFromPercent(blank, "10", EUR)).toBeNull();
  });
});

describe("<ProductForm /> — offering an add-on on NEW products", () => {
  it("is product STATE, so ticking it is an unsaved change", async () => {
    // The distinction from "offer on every existing product" one panel up: that
    // one is an action taken once and deliberately not part of the values, so
    // ticking it is not a dirty edit. This one is saved WITH the product, so it
    // must be.
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={{ ...buildProduct(), listed: false }}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    expect(screen.queryByText(form.unsavedChanges)).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: form.offerNewProducts }));

    expect(screen.getByText(form.unsavedChanges)).toBeInTheDocument();
  });

  it("travels on the PAYLOAD, not as the fan-out intent", async () => {
    // Two controls, two destinations: the flag is persisted product state, the
    // fan-out is a one-off action against a different endpoint.
    const user = userEvent.setup();
    const onSubmit =
      vi.fn<(value: unknown, images: unknown, offer?: unknown) => Promise<void>>(
        async () => {},
      );

    renderForm(
      <ProductForm
        product={{ ...buildProduct(), listed: false }}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: form.offerNewProducts }));
    await user.click(screen.getByRole("button", { name: form.submitSave }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ offerOnNewProducts: true });
    expect(onSubmit.mock.calls[0]?.[2]).toMatchObject({ everywhere: false });
  });

  it("is offered only for a product that is itself an add-on", () => {
    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    expect(
      screen.queryByRole("checkbox", { name: form.offerNewProducts }),
    ).not.toBeInTheDocument();
  });
});

describe("<ProductForm /> — stack discount", () => {
  it("replaces the freeform tier editor with a read-only preview when enabled", async () => {
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    expect(screen.getByRole("button", { name: form.addTier })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: form.stackDiscountEnabled }));

    expect(screen.queryByRole("button", { name: form.addTier })).not.toBeInTheDocument();
    // 49.99 EUR's own -30% tier, shown without anyone typing it.
    expect(screen.getByText(form.bestPriceBadge)).toBeInTheDocument();
  });

  it("submits the fixed schedule, not whatever the freeform rows held", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<
      (value: unknown, images: unknown, offer?: unknown, changes?: unknown) => Promise<void>
    >(async () => {});

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: form.stackDiscountEnabled }));
    await user.click(screen.getByRole("button", { name: form.submitSave }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    const value = onSubmit.mock.calls[0]?.[0] as {
      stackDiscountEnabled: boolean;
      variants: { priceTiers: { minQuantity: number; unitPriceGross: number }[] }[];
    };

    expect(value.stackDiscountEnabled).toBe(true);
    expect(value.variants[0]?.priceTiers).toEqual([
      { minQuantity: 2, unitPriceGross: 4499 },
      { minQuantity: 3, unitPriceGross: 4249 },
      { minQuantity: 5, unitPriceGross: 3499 },
      { minQuantity: 10, unitPriceGross: 2999 },
    ]);
  });
});

describe("spec fields — form and the certificate switch", () => {
  it("buildPayload submits the form and the showCoa switch, and never a purity label", () => {
    const result = buildPayload({ ...validValues(), form: "CAPSULE", showCoa: true }, messages);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.form).toBe("CAPSULE");
    expect(result.value.showCoa).toBe(true);
    expect(result.value).not.toHaveProperty("purityLabel");
  });

  it("toFormValues seeds both from an existing product, and safe defaults for a new one", () => {
    const seeded = toFormValues({ ...buildProduct(), form: "SOLUTION", showCoa: true }, EUR);
    expect(seeded.form).toBe("SOLUTION");
    expect(seeded.showCoa).toBe(true);

    const fresh = toFormValues(undefined, EUR);
    expect(fresh.form).toBe("LYOPHILIZED");
    // Hidden until someone decides otherwise.
    expect(fresh.showCoa).toBe(false);
  });

  it("no longer offers a purity field — purity is a fixed sitewide claim", () => {
    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={vi.fn(async () => {})}
        submitLabel={form.submitSave}
      />,
    );

    expect(screen.queryByRole("textbox", { name: /pureza/i })).not.toBeInTheDocument();
  });

  it("saves the chosen form and the 'show certificate' switch WITH the product", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<
      (value: unknown, images: unknown, offer?: unknown, changes?: unknown) => Promise<void>
    >(async () => {});

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: form.formLabel }),
      form.formOptions.SOLUTION,
    );
    const toggle = screen.getByRole("checkbox", { name: esMessages.admin.productCoa.showLabel });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    // Nothing is sent on flip: the switch is a form field like any other.
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: form.submitSave }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const value = onSubmit.mock.calls[0]?.[0] as { form: string; showCoa: boolean };
    expect(value.form).toBe("SOLUTION");
    expect(value.showCoa).toBe(true);
  });

  it("offers the certificate upload only when the caller supplies one", () => {
    const { unmount } = renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={vi.fn(async () => {})}
        submitLabel={form.submitSave}
      />,
    );
    // The section is always there (visibility is a product field); without
    // `coaUploads` it explains why no file can be added yet.
    expect(screen.getByText(esMessages.admin.productCoa.afterSave)).toBeInTheDocument();
    unmount();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={vi.fn(async () => {})}
        submitLabel={form.submitSave}
        coaUploads={{
          productId: buildProduct().id,
          onRequestUpload: vi.fn(),
          onAttach: vi.fn(),
          onRemove: vi.fn(),
        }}
      />,
    );
    expect(screen.getByText(esMessages.admin.productCoa.dropTitle)).toBeInTheDocument();
  });
});

describe("toFormValues", () => {
  it("round-trips an existing price without changing it by a cent", () => {
    // Load an existing product, build a payload from it untouched, and the price
    // must come back byte-identical. This is the regression that a naive
    // `price / 100` then `* 100` would fail.
    const values = toFormValues(buildProduct(), EUR);
    expect(values.variants[0]?.priceGross).toBe("49.99");
    expect(values.variants[0]?.compareAtGross).toBe("59.99");

    const rebuilt = buildPayload(values, messages);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.variants[0]?.priceGross).toBe(4999);
    expect(rebuilt.value.variants[0]?.compareAtGross).toBe(5999);
  });

  it("round-trips a stored tier without changing it by a cent", () => {
    const stored = buildProduct();
    const withTier: Product = {
      ...stored,
      variants: stored.variants.map((variant) => ({
        ...variant,
        priceTiers: [{ minQuantity: 3, unitPriceGross: toMinor(4499) }],
      })),
    };

    const values = toFormValues(withTier, EUR);
    expect(values.variants[0]?.priceTiers).toHaveLength(1);
    expect(values.variants[0]?.priceTiers[0]?.minQuantity).toBe("3");
    expect(values.variants[0]?.priceTiers[0]?.unitPriceGross).toBe("44.99");

    // And back out again at the same figure — `formatMinorAsInput` is the
    // inverse of `parseMajorUnitInput`, and an untouched save must not move it.
    const rebuilt = buildPayload(values, messages);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.variants[0]?.priceTiers).toEqual([
      { minQuantity: 3, unitPriceGross: 4499 },
    ]);
  });

  it("seeds blank defaults for a new product", () => {
    const values = toFormValues(undefined, EUR);
    expect(values.slug).toBe("");
    expect(values.status).toBe("DRAFT");
    expect(values.variants).toHaveLength(1);
    // Listed unless somebody says otherwise: an add-on is a deliberate choice,
    // never the one made by forgetting.
    expect(values.listed).toBe(true);
    expect(values.categoryIds).toEqual([]);
  });

  it("seeds categoryIds from the stored product, so an existing assignment survives the round trip", () => {
    const stored: Product = {
      ...buildProduct(),
      categories: [
        { id: "11111111-1111-4111-8111-111111111111", slug: "recuperacion", name: { es: "Recuperación", en: "Recovery" }, sortOrder: 0 },
        { id: "22222222-2222-4222-8222-222222222222", slug: "rendimiento", name: { es: "Rendimiento", en: "Performance" }, sortOrder: 1 },
      ],
    };

    const values = toFormValues(stored, EUR);
    expect(values.categoryIds).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);

    const rebuilt = buildPayload(values, messages);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.categoryIds).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });

  it("round-trips an add-on rather than re-listing it on save", () => {
    // The failure this pins is silent and total: seed the flag wrong and every
    // save of an untouched add-on puts it back in the shop's index.
    const values = toFormValues({ ...buildProduct(), listed: false }, EUR);
    expect(values.listed).toBe(false);

    const rebuilt = buildPayload(values, messages);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.listed).toBe(false);
  });

  it("exposes both locales even when the product only has one", () => {
    // Otherwise an operator can never ADD the English copy to a Spanish-only
    // product — there would be no draft behind the English segment to type into.
    const values = toFormValues(buildProduct(), EUR);
    expect(values.translations.map((t) => t.locale)).toEqual(["es", "en"]);
  });

  it("carries a variant's per-locale name even though no input shows it", () => {
    // There is no "Nombre" cell for a variant, and saving must not erase what
    // the form cannot display.
    const values = toFormValues(buildProduct(), EUR);
    const rebuilt = buildPayload(values, messages);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.variants[0]?.name).toEqual({ es: "10 mg", en: "10 mg" });
  });

  it("defaults stackDiscountEnabled to false for a new product", () => {
    const values = toFormValues(undefined, EUR);
    expect(values.stackDiscountEnabled).toBe(false);
  });

  it("seeds stackDiscountEnabled from an existing product", () => {
    const values = toFormValues({ ...buildProduct(), stackDiscountEnabled: true }, EUR);
    expect(values.stackDiscountEnabled).toBe(true);
  });
});

describe("<ProductForm /> — pack components alongside add-ons", () => {
  const PACK_COMPONENT_CANDIDATES: readonly PackComponentCandidate[] = [
    { id: "c1", slug: "creatina", name: "Creatina" },
    { id: "c2", slug: "magnesio", name: "Magnesio" },
  ];
  const ADD_ON_CANDIDATES: readonly AddOnCandidate[] = [
    { id: "a1", slug: "shaker", name: "Shaker" },
  ];

  it("shows BOTH panels for a PACK product — a pack can offer add-ons on its own page too", () => {
    renderForm(
      <ProductForm
        product={{ ...buildProduct(), kind: "PACK" }}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
        addOnCandidates={ADD_ON_CANDIDATES}
        packComponentCandidates={PACK_COMPONENT_CANDIDATES}
      />,
    );

    expect(screen.getByText(form.packComponentsTitle)).toBeInTheDocument();
    expect(screen.getByText(form.addOnsTitle)).toBeInTheDocument();
  });

  it("shows only the add-ons panel for a SIMPLE product, even when pack candidates are supplied", () => {
    renderForm(
      <ProductForm
        product={{ ...buildProduct(), kind: "SIMPLE" }}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
        addOnCandidates={ADD_ON_CANDIDATES}
        packComponentCandidates={PACK_COMPONENT_CANDIDATES}
      />,
    );

    expect(screen.queryByText(form.packComponentsTitle)).not.toBeInTheDocument();
    expect(screen.getByText(form.addOnsTitle)).toBeInTheDocument();
  });

  it("shows neither panel when no candidates were supplied at all", () => {
    renderForm(
      <ProductForm
        product={{ ...buildProduct(), kind: "PACK" }}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    expect(screen.queryByText(form.packComponentsTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(form.addOnsTitle)).not.toBeInTheDocument();
  });
});

describe("<ProductForm /> — category assignment", () => {
  const CATEGORIES = [
    { id: "11111111-1111-4111-8111-111111111111", slug: "recuperacion", name: { es: "Recuperación", en: "Recovery" }, sortOrder: 0 },
    { id: "22222222-2222-4222-8222-222222222222", slug: "rendimiento", name: { es: "Rendimiento", en: "Performance" }, sortOrder: 1 },
  ];

  it("renders no panel at all when the page did not supply a category list", () => {
    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    expect(screen.queryByText(form.categoriesTitle)).not.toBeInTheDocument();
  });

  it("pre-checks the categories the stored product already belongs to", () => {
    const recuperacion = CATEGORIES[0];
    if (recuperacion === undefined) throw new Error("expected a first category");

    renderForm(
      <ProductForm
        product={{ ...buildProduct(), categories: [recuperacion] }}
        currency={EUR}
        categories={CATEGORIES}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Recuperación" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Rendimiento" })).not.toBeChecked();
  });

  it("submits the ticked categories on save, not the hardcoded empty list this form used to send", async () => {
    const user = userEvent.setup();
    const onSubmit =
      vi.fn<(value: unknown, images: unknown, offer?: unknown) => Promise<void>>(
        async () => {},
      );

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        categories={CATEGORIES}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Rendimiento" }));
    await user.click(screen.getByRole("button", { name: form.submitSave }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ categoryIds: ["22222222-2222-4222-8222-222222222222"] });
  });
});

/**
 * `classifyVariantChanges` — the sort that makes an EDIT save actually reach
 * an existing variant's fields, or create a row that never existed.
 *
 * Every test here round-trips through the real `toFormValues` → (mutate) →
 * `buildPayload` sequence, exactly as `handleSubmit` does, rather than
 * hand-building a `CreateVariant[]` — so a drift between what `buildPayload`
 * actually produces and what this function expects would fail here, not only
 * in production.
 */
describe("classifyVariantChanges", () => {
  /** An untouched round-trip: load, rebuild, classify. Nothing should move. */
  function loadAndClassify(product: Product, mutate?: (values: ReturnType<typeof toFormValues>) => ReturnType<typeof toFormValues>) {
    const values0 = toFormValues(product, EUR);
    const values = mutate === undefined ? values0 : mutate(values0);
    const built = buildPayload(values, messages);
    if (!built.ok) {
      throw new Error("fixture must build a valid payload");
    }
    return classifyVariantChanges(values, product, built.value.variants);
  }

  it("finds nothing to do when nothing changed", () => {
    const result = loadAndClassify(buildProduct());
    expect(result.newVariants).toEqual([]);
    expect(result.updatedVariants).toEqual([]);
    expect(result.inventoryPolicyChanges).toEqual([]);
  });

  it("sends only the price when only the price changed", () => {
    const product = buildProduct();
    const result = loadAndClassify(product, (values) => ({
      ...values,
      variants: values.variants.map((variant) => ({ ...variant, priceGross: "59.99" })),
    }));

    expect(result.newVariants).toEqual([]);
    expect(result.updatedVariants).toEqual([
      {
        variantId: product.variants[0]?.id,
        sku: "AK-BPC-10",
        patch: { version: 3, priceGross: 5999 },
      },
    ]);
    expect(result.inventoryPolicyChanges).toEqual([]);
  });

  it("carries the stored version, for optimistic concurrency", () => {
    const product = {
      ...buildProduct(),
      variants: buildProduct().variants.map((variant) => ({ ...variant, version: 41 })),
    };
    const result = loadAndClassify(product, (values) => ({
      ...values,
      variants: values.variants.map((variant) => ({ ...variant, sku: "AK-BPC-10-NEW" })),
    }));

    expect(result.updatedVariants[0]?.patch.version).toBe(41);
  });

  it("bundles name and options together when the size changes, even though only one is asked for", () => {
    // The two are one piece of state — a size — and sending only one would
    // leave the stored pair inconsistent with each other.
    const result = loadAndClassify(buildProduct(), (values) => ({
      ...values,
      variants: values.variants.map((variant) => ({
        ...variant,
        sizeAmount: "20",
        sizeUnit: "mg",
      })),
    }));

    expect(result.updatedVariants[0]?.patch).toMatchObject({
      name: { es: "20 mg", en: "20 mg" },
      options: { size: "20 mg" },
    });
  });

  it("detects a changed price tier even when the count of tiers is unchanged", () => {
    const stored = buildProduct();
    const product: Product = {
      ...stored,
      variants: stored.variants.map((variant) => ({
        ...variant,
        priceTiers: [{ minQuantity: 3, unitPriceGross: toMinor(4499) }],
      })),
    };

    const result = loadAndClassify(product, (values) => ({
      ...values,
      variants: values.variants.map((variant) => ({
        ...variant,
        priceTiers: [{ key: "t-3", minQuantity: "3", unitPriceGross: "39.99" }],
      })),
    }));

    expect(result.updatedVariants[0]?.patch.priceTiers).toEqual([
      { minQuantity: 3, unitPriceGross: 3999 },
    ]);
  });

  it("picks up a stack-discount schedule recompute on a price edit, with no extra wiring", () => {
    // `classifyVariantChanges` is unaware stack discount exists: it diffs
    // whatever `buildPayload` produced against what is stored, which is exactly
    // what makes this scenario work with no dedicated code path for it.
    const stored = buildProduct();
    const product: Product = {
      ...stored,
      stackDiscountEnabled: true,
      variants: stored.variants.map((variant) => ({
        ...variant,
        priceTiers: [
          { minQuantity: 2, unitPriceGross: toMinor(4499) },
          { minQuantity: 3, unitPriceGross: toMinor(4249) },
          { minQuantity: 5, unitPriceGross: toMinor(3499) },
          { minQuantity: 10, unitPriceGross: toMinor(2999) },
        ],
      })),
    };

    const result = loadAndClassify(product, (values) => ({
      ...values,
      variants: values.variants.map((variant) => ({ ...variant, priceGross: "59.99" })),
    }));

    // 59.99 EUR at -10/-15/-30/-40%.
    expect(result.updatedVariants[0]?.patch).toMatchObject({
      priceGross: 5999,
      priceTiers: [
        { minQuantity: 2, unitPriceGross: 5399 },
        { minQuantity: 3, unitPriceGross: 5099 },
        { minQuantity: 5, unitPriceGross: 4199 },
        { minQuantity: 10, unitPriceGross: 3599 },
      ],
    });
  });

  it("routes the reorder threshold and backorder flag to the inventory-policy list, not the variant patch", () => {
    const product = buildProduct();
    const result = loadAndClassify(product, (values) => ({
      ...values,
      variants: values.variants.map((variant) => ({
        ...variant,
        lowStockThreshold: "10",
        allowBackorder: true,
      })),
    }));

    expect(result.updatedVariants).toEqual([]);
    expect(result.inventoryPolicyChanges).toEqual([
      {
        variantId: product.variants[0]?.id,
        sku: "AK-BPC-10",
        policy: { lowStockThreshold: 10, allowBackorder: true },
      },
    ]);
  });

  it("never sends initialStock — the field is a ledger balance, not a settable one", () => {
    // Changing this in form state directly (bypassing the disabled input, the
    // way a test can but an operator cannot) must still not produce a write:
    // this function is the actual guarantee, the disabled input is only the
    // visible half of it.
    const result = loadAndClassify(buildProduct(), (values) => ({
      ...values,
      variants: values.variants.map((variant) => ({ ...variant, initialStock: "999" })),
    }));

    expect(result.updatedVariants).toEqual([]);
    expect(result.inventoryPolicyChanges).toEqual([]);
  });

  it("treats a row with no stored match as new, regardless of what else changed", () => {
    const product = buildProduct();
    const values = toFormValues(product, EUR);
    const withNewRow = {
      ...values,
      variants: [
        ...values.variants,
        {
          key: "new-1",
          version: 0,
          sku: "AK-BPC-20",
          nameEs: "",
          nameEn: "",
          sizeAmount: "20",
          sizeUnit: "mg" as SizeUnit,
          priceGross: "89.99",
          compareAtGross: "",
          weightGrams: "30",
          initialStock: "5",
          lowStockThreshold: "5",
          allowBackorder: false,
          stagedImage: null,
          priceTiers: [],
        },
      ],
    };
    const built = buildPayload(withNewRow, messages);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const result = classifyVariantChanges(withNewRow, product, built.value.variants);

    expect(result.newVariants).toHaveLength(1);
    expect(result.newVariants[0]?.sku).toBe("AK-BPC-20");
    // The existing, untouched row is neither updated nor added again.
    expect(result.updatedVariants).toEqual([]);
  });
});

describe("stagedVariantImages", () => {
  it("tags each file with the SKU being submitted, trimmed exactly as the payload is", () => {
    const values = withVariant({ sku: "  AK-BPC-20  ", stagedImage: stagedImage("vial.png") });

    // Trimmed on both sides of the seam, so the lookup that places this file on
    // a created variant cannot miss by a stray space the operator never sees.
    expect(stagedVariantImages(values)).toEqual([
      { sku: "AK-BPC-20", image: values.variants[0]?.stagedImage },
    ]);
  });

  it("says nothing about a variant nobody gave an image", () => {
    expect(stagedVariantImages(validValues())).toEqual([]);
  });
});

describe("<ProductForm />", () => {
  it("submits a validated payload with minor-unit pricing", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: unknown) => Promise<void>>(async () => {});

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: form.submitSave }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      slug: "bpc-157",
      variants: [{ priceGross: 4999, compareAtGross: 5999 }],
    });
  });

  it("appends the closed accent-divider preset to the description on one click", async () => {
    // Item 2 Track B: the only sanctioned way to get a colored separator is
    // this exact literal markup, matching `libs/rich-text`'s allowlist.
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: unknown) => Promise<void>>(async () => {});

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    const description = screen.getByLabelText(form.descriptionLabel);
    await user.click(screen.getByRole("button", { name: form.insertDivider }));

    expect(description).toHaveValue(
      'Descripción\n<hr class="divider--accent">\n',
    );
  });

  it("does not call onSubmit when a price is invalid", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: unknown) => Promise<void>>(async () => {});

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    // The price cell's input still has its own accessible name — the column
    // header is not one, and `labelHidden` keeps the label in the a11y tree.
    const price = screen.getByLabelText(form.priceLabel.replace("{currency}", EUR));
    await user.clear(price);
    await user.type(price, "49.999");
    await user.click(screen.getByRole("button", { name: form.submitSave }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      await screen.findByText(esMessages.admin.common.moneyErrors.TOO_MANY_DECIMALS),
    ).toBeInTheDocument();
  });

  it("gives every variant cell an accessible name of its own", () => {
    // A column header does NOT name a cell's input: a screen reader moving cell
    // by cell would reach six boxes called nothing at all. This is the assertion
    // that fails if a future compaction drops `labelHidden` for a bare input.
    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    for (const label of [
      form.skuLabel,
      form.priceLabel.replace("{currency}", EUR),
      form.compareAtLabel,
      form.initialStockLabel,
      form.thresholdLabel,
      form.weightLabel,
      form.allowBackorder,
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }

    // And the card itself is named, so "the second variant" is answerable.
    // The variants are a list of nested <fieldset>s now rather than table rows,
    // so the name is carried by each card's <legend> — role "group". The Panel
    // around them is also a group, but it is named "Variantes", so this query
    // cannot match it by accident.
    expect(
      screen.getByRole("group", { name: form.variantHeading.replace("{index}", "1") }),
    ).toBeInTheDocument();
  });

  it("makes a product an add-on from the sidebar and submits the flag", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: unknown) => Promise<void>>(async () => {});

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    const control = screen.getByLabelText(form.listingLabel);
    // The named outcome, not the column's word: an operator should never have to
    // know what `listed` is called in the database.
    expect(control).toHaveValue("LISTED");
    // And the consequence is stated where the choice is made — without it the
    // safe reading is "this hides the product", and nobody would ever pick it.
    expect(screen.getByText(form.listingHint)).toBeInTheDocument();

    await user.selectOptions(control, "ADDON");
    await user.click(screen.getByRole("button", { name: form.submitSave }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ listed: false });
  });

  it("offers the fan-out only for a product that is itself an add-on", async () => {
    // Offering a CATALOGUE product on every other product's page is not a thing
    // anyone wants, so the control does not exist until the product is an
    // add-on. Hiding it is the honest shape: a disabled checkbox would invite
    // the question "why can I not tick this?".
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    expect(
      screen.queryByRole("checkbox", { name: form.offerEverywhere }),
    ).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(form.listingLabel), "ADDON");

    expect(screen.getByRole("checkbox", { name: form.offerEverywhere })).toBeInTheDocument();
  });

  it("reports the fan-out as a THIRD argument, never as part of the payload", async () => {
    // It is a SECOND write against a different endpoint. Folding it into
    // `CreateProduct` would put a cross-catalogue merchandising action inside
    // the contract for one product, and the API would have to ignore it.
    const user = userEvent.setup();
    const onSubmit =
      vi.fn<(value: unknown, images: unknown, offer?: unknown) => Promise<void>>(
        async () => {},
      );

    renderForm(
      <ProductForm
        product={{ ...buildProduct(), listed: false }}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: form.offerEverywhere }));
    await user.click(screen.getByRole("button", { name: form.submitSave }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[2]).toMatchObject({ everywhere: true });
    // And the payload itself is untouched by it.
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("everywhere");
  });

  it("says nothing when the box is left alone", async () => {
    const user = userEvent.setup();
    const onSubmit =
      vi.fn<(value: unknown, images: unknown, offer?: unknown) => Promise<void>>(
        async () => {},
      );

    renderForm(
      <ProductForm
        product={{ ...buildProduct(), listed: false }}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: form.submitSave }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[2]).toMatchObject({ everywhere: false });
  });

  it("does not count ticking it as an unsaved change", async () => {
    // THE REASON IT IS HELD OUTSIDE `ProductFormValues`. `dirty` compares that
    // object structurally, so parking this there would mark the form dirty for
    // a box that changes nothing about the product itself. Starts from a
    // product that is ALREADY an add-on, because switching the listing control
    // genuinely IS an edit and would mask what this asserts.
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={{ ...buildProduct(), listed: false }}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    expect(screen.queryByText(form.unsavedChanges)).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: form.offerEverywhere }));

    expect(screen.queryByText(form.unsavedChanges)).not.toBeInTheDocument();
  });

  it("previews the description as the shop will render it, per locale", async () => {
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    // BEHIND THE EYE NOW, not under the field. Each assertion opens the dialog
    // and closes it again, which is the shape of the feature: the form is the
    // form, and how the shop draws it is something you go and look at.
    const openPreview = async () => {
      await user.click(screen.getByRole("button", { name: form.previewProduct }));
    };
    const closePreview = async () => {
      await user.click(screen.getByRole("button", { name: esMessages.ui.close }));
    };

    await openPreview();
    expect(screen.getByRole("region", { name: form.previewLabel })).toHaveTextContent(
      "Descripción",
    );
    await closePreview();

    // The preview belongs to the copy on screen, and it now mirrors the shop:
    // the storefront omits the description SECTION entirely when there is no
    // description, so the preview shows no region at all rather than a
    // dashboard-only "nothing here yet" sentence. The fixture has no English
    // description, so switching must drop the section — not carry the Spanish
    // markup over from the segment before.
    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    await openPreview();
    expect(
      screen.queryByRole("region", { name: form.previewLabel }),
    ).not.toBeInTheDocument();
    await closePreview();

    await user.type(screen.getByLabelText(form.descriptionLabel), "<p>Vial</p>");
    await openPreview();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: form.previewLabel })).toHaveTextContent(
        "Vial",
      ),
    );

    // Rendered as MARKUP, not as the escaped text the field used to show.
    // SCOPED TO THE PREVIEW: the textarea legitimately still holds the literal
    // "<p>Vial</p>" the operator typed, so a document-wide query for that string
    // finds the input and proves nothing about what was drawn.
    expect(
      screen.getByRole("region", { name: form.previewLabel }).textContent,
    ).not.toContain("<p>");
  });

  it("has no image column when the caller cannot store one", () => {
    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    // The column costs horizontal room in a table whose density is the reason
    // it is a table, so a caller with nowhere to put an image gets no column —
    // not a disabled one.
    expect(screen.queryByRole("columnheader", { name: form.columns.image })).toBeNull();
  });

  it("names each row's image control after that row's own variant", async () => {
    const user = userEvent.setup();

    renderForm(
      <ToastProvider closeLabel={esMessages.ui.close}>
        <ProductForm
          currency={EUR}
          onSubmit={async () => {}}
          submitLabel={form.submitCreate}
          variantImages={{ mode: "staged" }}
        />
      </ToastProvider>,
    );

    // There is no image COLUMN any more — the control sits at the head of its
    // own card — so what has to be true is that the card is named, which is what
    // makes the button names below distinguishable.
    expect(
      screen.getByRole("group", { name: form.variantHeading.replace("{index}", "1") }),
    ).toBeInTheDocument();

    // Before there is a SKU the row heading is the only thing that tells two of
    // these apart — a column of buttons all called "Añadir imagen" names none of
    // them, and a column header does not name a cell for a screen reader moving
    // cell by cell.
    const byIndex = variantImage.add.replace(
      "{variant}",
      form.variantHeading.replace("{index}", "1"),
    );
    expect(screen.getByRole("button", { name: byIndex })).toBeInTheDocument();

    await user.type(screen.getByLabelText(form.skuLabel), "AK-BPC-20");

    // And once the operator has typed one, the control is named by the value
    // they typed rather than by a row number they never see again.
    expect(
      screen.getByRole("button", { name: variantImage.add.replace("{variant}", "AK-BPC-20") }),
    ).toBeInTheDocument();
  });

  it("announces the validation failure through role=alert", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: unknown) => Promise<void>>(async () => {});

    renderForm(
      <ProductForm currency={EUR} onSubmit={onSubmit} submitLabel={form.submitCreate} />,
    );

    await user.click(screen.getByRole("button", { name: form.submitCreate }));

    // A blank new-product form must report its problems accessibly, not just as
    // red text a screen reader never reaches.
    expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("adds and removes variants but never removes the last one", async () => {
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    expect(screen.getAllByTestId("variant-row")).toHaveLength(1);
    // With one variant there is nothing to remove: the variant is the sellable
    // unit, so a product with none can never be bought.
    expect(screen.queryByRole("button", { name: form.removeVariant })).toBeNull();

    await user.click(screen.getByRole("button", { name: form.addVariant }));
    expect(screen.getAllByTestId("variant-row")).toHaveLength(2);

    const removeButtons = screen.getAllByRole("button", { name: form.removeVariant });
    await user.click(removeButtons[0] as HTMLElement);
    expect(screen.getAllByTestId("variant-row")).toHaveLength(1);
  });

  it("re-enables the submit button after a failed save", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: unknown) => Promise<void>>(async () => {
      throw new Error("API is down");
    });

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: form.submitSave }));

    // Leaving the button disabled after a failure strands the operator with no
    // way to retry.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: form.submitSave })).toBeEnabled(),
    );

    // And the failure must be VISIBLE. An async event handler that lets its
    // rejection escape produces an unhandled promise rejection: no error
    // boundary catches it, and the form looks like it saved.
    expect(await screen.findByRole("alert")).toHaveTextContent("API is down");
  });

  /**
   * THE FREEZE, asserted directly — it is the easiest thing in the form to
   * lose: swap a `<fieldset>` for a `<div>` and every panel keeps its paint
   * while the whole form quietly stops disabling on submit. Now checked across
   * a sidebar field, a table cell AND the locale switch, because the table and
   * the switch are new boxes that a `<div>` rewrite would take with it.
   */
  it("freezes every field while the save is in flight", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const onSubmit = vi.fn<(value: unknown) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    const slug = screen.getByLabelText(form.slugLabel);
    expect(slug).toBeEnabled();

    await user.click(screen.getByRole("button", { name: form.submitSave }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    // Fields in THREE different panels and three different shapes: the freeze
    // belongs to every fieldset, not to a prop threaded into one input.
    expect(slug).toBeDisabled();
    expect(screen.getByLabelText(form.nameLabel)).toBeDisabled();
    expect(screen.getByLabelText(form.skuLabel)).toBeDisabled();
    expect(screen.getByRole("radio", { name: ENGLISH })).toBeDisabled();

    release?.();
    await waitFor(() => expect(slug).toBeEnabled());
  });

  it("names each panel with its legend", () => {
    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    // A `<legend>` is what gives a `<fieldset>` its accessible name, and the
    // name is what a screen reader announces before every field inside it.
    // Losing it is invisible on screen and total in the accessibility tree.
    expect(screen.getByRole("group", { name: form.productTitle })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: form.variantsTitle })).toBeInTheDocument();
    // The copy panel names the language it is currently editing, so "Nombre" is
    // never announced without saying which language that name is for.
    expect(
      screen.getByRole("group", {
        name: form.sectionCopy.replace("{language}", "Español"),
      }),
    ).toBeInTheDocument();
  });

  it("edits one locale at a time and keeps the other in state", async () => {
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    // ONE name field, not two: this is the density win, and the assertion that
    // fails the day somebody re-adds the second copy card.
    expect(screen.getAllByLabelText(form.nameLabel)).toHaveLength(1);
    expect(screen.getByLabelText(form.nameLabel)).toHaveValue("BPC-157");

    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    const englishName = screen.getByLabelText(form.nameLabel);
    expect(englishName).toHaveValue("");
    await user.type(englishName, "BPC-157 EN");

    // Back to Spanish: what was typed in English must still exist, and the
    // Spanish copy must be exactly what it was.
    await user.click(screen.getByRole("radio", { name: SPANISH }));
    expect(screen.getByLabelText(form.nameLabel)).toHaveValue("BPC-157");
    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    expect(screen.getByLabelText(form.nameLabel)).toHaveValue("BPC-157 EN");
  });

  it("counts the empty fields of the locale that is behind without switching to it", async () => {
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    // The fixture has Spanish copy and no English at all: three empty fields,
    // stated on the English segment while the Spanish copy is on screen. This
    // is what the two side-by-side cards used to be for, and it is why the
    // count is a full sentence rather than a bare red dot.
    const english = screen.getByRole("radio", { name: ENGLISH });
    expect(screen.getByText("3 campos vacíos")).toBeInTheDocument();

    await user.click(english);
    await user.type(screen.getByLabelText(form.nameLabel), "BPC-157");
    expect(screen.getByText("2 campos vacíos")).toBeInTheDocument();
  });

  it("switches to the offending locale when the rejected copy is off screen", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: unknown) => Promise<void>>(async () => {});

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={onSubmit}
        submitLabel={form.submitSave}
      />,
    );

    // An English name that is too long for the contract, then left behind the
    // Spanish segment. Without the switch the save would be refused with the
    // reason drawn on a panel nobody can see.
    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    await user.click(screen.getByLabelText(form.nameLabel));
    // PASTED rather than typed: 300 keystrokes is 300 re-renders of the whole
    // form, and the test is about where the error lands, not about typing.
    await user.paste("x".repeat(300));
    await user.click(screen.getByRole("radio", { name: SPANISH }));

    await user.click(screen.getByRole("button", { name: form.submitSave }));

    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: ENGLISH })).toBeChecked(),
    );
    expect(screen.getByLabelText(form.nameLabel)).toBeInvalid();
  });

  it("offers translation only when a handler is supplied", () => {
    // The SOURCE is the language not on screen, and the label says so: with the
    // Spanish segment selected, the button translates FROM English.
    const translateLabel = form.translate.replace("{language}", "English");

    const { unmount } = renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );
    // Unwired — which is the shipped state — the panel is exactly as it was.
    expect(screen.queryByRole("button", { name: translateLabel })).toBeNull();
    unmount();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        onTranslate={async () => ({ name: "", shortDescription: "", description: "" })}
        submitLabel={form.submitSave}
      />,
    );
    // On the Spanish segment the source is English, which is empty here, so the
    // button exists and refuses to spend a round trip on nothing.
    expect(screen.getByRole("button", { name: translateLabel })).toBeDisabled();
  });

  it("fills the visible locale from the other one and never loses the source", async () => {
    const user = userEvent.setup();
    const onTranslate = vi.fn<(request: TranslateCopyRequest) => Promise<ProductCopyDraft>>(
      async () => ({
        name: "BPC-157",
        shortDescription: "Peptide",
        description: "Description",
      }),
    );

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        onTranslate={onTranslate}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    await user.click(
      screen.getByRole("button", { name: form.translate.replace("{language}", "Español") }),
    );

    await waitFor(() => expect(onTranslate).toHaveBeenCalledTimes(1));
    // The direction is stated in the request, not inferred: the button says
    // "from Spanish" while the English fields are on screen.
    expect(onTranslate.mock.calls[0]?.[0]).toEqual({
      from: "es",
      to: "en",
      copy: {
        name: "BPC-157",
        shortDescription: "Péptido",
        description: "Descripción",
      },
    });

    await waitFor(() => expect(screen.getByLabelText(form.nameLabel)).toHaveValue("BPC-157"));
    expect(screen.getByLabelText(form.summaryLabel)).toHaveValue("Peptide");

    // The source language is untouched.
    await user.click(screen.getByRole("radio", { name: SPANISH }));
    expect(screen.getByLabelText(form.summaryLabel)).toHaveValue("Péptido");
  });

  it("reports its own message when the translation fails", async () => {
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        onTranslate={async () => {
          // The handler's own English, of the kind an upstream failure produces.
          throw new Error("translate upstream returned 502");
        }}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    await user.click(
      screen.getByRole("button", { name: form.translate.replace("{language}", "Español") }),
    );

    // The operator reads this form's sentence, never the handler's own English.
    expect(await screen.findByText(form.translateFailed)).toBeInTheDocument();
    expect(screen.queryByText(/502/)).toBeNull();
    expect(screen.getByLabelText(form.nameLabel)).toHaveValue("");
  });

  it("shows the unsaved-changes marker only once something has changed", async () => {
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    expect(screen.queryByText(form.unsavedChanges)).toBeNull();

    await user.type(screen.getByLabelText(form.slugLabel), "-x");
    expect(screen.getByText(form.unsavedChanges)).toBeInTheDocument();
  });

  it("does not treat a locale switch as an unsaved change", async () => {
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    // Looking at the English copy is not editing it. The marker warns about
    // work that would be lost, and switching a segment loses nothing.
    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    expect(screen.queryByText(form.unsavedChanges)).toBeNull();
  });

  /**
   * A product whose copy is written in BOTH languages.
   *
   * Every clobber assertion needs one: the button is disabled while the source
   * is blank, so a product with Spanish only can never reach the case where the
   * TARGET already has text in it.
   */
  function bilingualProduct(): Product {
    return {
      ...buildProduct(),
      translations: [
        {
          locale: "es",
          name: "BPC-157",
          shortDescription: "Péptido",
          description: "Descripción",
        },
        {
          locale: "en",
          name: "Written by a human",
          shortDescription: "Human summary",
          description: "Human description",
        },
      ],
    };
  }

  it("asks before it overwrites copy somebody already wrote", async () => {
    const user = userEvent.setup();
    const onTranslate = vi.fn<(request: TranslateCopyRequest) => Promise<ProductCopyDraft>>(
      async () => ({
        name: "Machine name",
        shortDescription: "Machine summary",
        description: "Machine description",
      }),
    );

    renderForm(
      <ProductForm
        product={bilingualProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        onTranslate={onTranslate}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    await user.click(
      screen.getByRole("button", { name: form.translate.replace("{language}", "Español") }),
    );

    // NOTHING HAS HAPPENED YET. Losing a paragraph an operator typed is worse
    // than making them press twice, and this form has no undo.
    expect(onTranslate).not.toHaveBeenCalled();
    expect(screen.getByLabelText(form.nameLabel)).toHaveValue("Written by a human");
    expect(
      screen.getByText(form.translateOverwrite.replace("{language}", "English")),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: form.translateOverwriteConfirm }));

    await waitFor(() => expect(onTranslate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByLabelText(form.nameLabel)).toHaveValue("Machine name"),
    );
  });

  it("keeps the written copy when the overwrite is declined", async () => {
    const user = userEvent.setup();
    const onTranslate = vi.fn<(request: TranslateCopyRequest) => Promise<ProductCopyDraft>>(
      async () => ({ name: "Machine name", shortDescription: "", description: "" }),
    );

    renderForm(
      <ProductForm
        product={bilingualProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        onTranslate={onTranslate}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    await user.click(
      screen.getByRole("button", { name: form.translate.replace("{language}", "Español") }),
    );
    await user.click(screen.getByRole("button", { name: esMessages.ui.cancel }));

    expect(onTranslate).not.toHaveBeenCalled();
    expect(screen.getByLabelText(form.nameLabel)).toHaveValue("Written by a human");
    expect(
      screen.queryByText(form.translateOverwrite.replace("{language}", "English")),
    ).toBeNull();
  });

  it("marks machine-written copy as unreviewed until somebody edits it", async () => {
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        // Spanish only, so the English target is blank and no confirmation is
        // asked for — the ordinary path this feature exists for.
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        onTranslate={async () => ({
          name: "BPC-157",
          shortDescription: "Peptide",
          description: "Description",
        })}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    await user.click(
      screen.getByRole("button", { name: form.translate.replace("{language}", "Español") }),
    );

    // An operator who cannot tell their own copy from a vendor's guess ships the
    // guess — and this is EU food-supplement copy.
    expect(await screen.findByText(form.machineTranslated)).toBeInTheDocument();
    // Said on the segment too, so it survives a switch to the other language.
    expect(
      screen.getByRole("radio", { name: new RegExp(form.machineTranslatedShort) }),
    ).toBeInTheDocument();

    // A keystroke IS the review: the operator has now taken responsibility for
    // the text.
    await user.type(screen.getByLabelText(form.nameLabel), "!");
    expect(screen.queryByText(form.machineTranslated)).toBeNull();
  });

  it("clears the unreviewed marker when the operator confirms instead of editing", async () => {
    const user = userEvent.setup();

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        onTranslate={async () => ({
          name: "BPC-157",
          shortDescription: "Peptide",
          description: "Description",
        })}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    await user.click(
      screen.getByRole("button", { name: form.translate.replace("{language}", "Español") }),
    );
    await user.click(await screen.findByRole("button", { name: form.markReviewed }));

    // A translation that is right as it stands still has to be READ, and saying
    // so is the whole of the review. Editing is not the only way to do it.
    expect(screen.queryByText(form.machineTranslated)).toBeNull();
  });

  it("renders the handler's own sentence when it names the failure", async () => {
    const user = userEvent.setup();
    const quotaSentence = form.translateErrors.QUOTA_EXCEEDED;

    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        onTranslate={async () => {
          // The seam's owner is the only side that can name the failure, and
          // this class is what promises the string is already translated.
          throw new TranslateCopyError(quotaSentence);
        }}
        submitLabel={form.submitSave}
      />,
    );

    await user.click(screen.getByRole("radio", { name: ENGLISH }));
    await user.click(
      screen.getByRole("button", { name: form.translate.replace("{language}", "Español") }),
    );

    expect(await screen.findByText(quotaSentence)).toBeInTheDocument();
    // Not stacked on the generic one: a specific reason replaces it.
    expect(screen.queryByText(form.translateFailed)).toBeNull();
  });

  it("disables translation with one line when the deployment has no vendor key", async () => {
    renderForm(
      <ProductForm
        product={bilingualProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        onTranslate={async () => ({ name: "", shortDescription: "", description: "" })}
        translateUnavailable={form.translateErrors.NOT_CONFIGURED}
        submitLabel={form.submitSave}
      />,
    );

    expect(
      screen.getByRole("button", { name: form.translate.replace("{language}", "English") }),
    ).toBeDisabled();
    expect(screen.getByText(form.translateErrors.NOT_CONFIGURED)).toBeInTheDocument();
    // DEGRADED, NOT BROKEN: the rest of the form is untouched.
    expect(screen.getByRole("button", { name: form.submitSave })).toBeEnabled();
    expect(screen.getByLabelText(form.slugLabel)).toBeEnabled();
  });
});

/**
 * Two variants of one product, so the size rules have something to be about.
 * `withVariant` only reaches the first one.
 */
function twoVariants(
  first: Partial<ReturnType<typeof validValues>["variants"][number]>,
  second: Partial<ReturnType<typeof validValues>["variants"][number]>,
) {
  const values = validValues();
  const [variant] = values.variants;
  if (variant === undefined) {
    throw new Error("validValues() must define at least one variant");
  }
  return {
    ...values,
    variants: [
      { ...variant, ...first },
      { ...variant, key: "v2", sku: "AK-BPC-20", ...second },
    ],
  };
}

describe("variant size", () => {
  it("names a sized variant in BOTH locales, not just the one on screen", () => {
    // The name is what the storefront renders as the picker's label, and it
    // renders per shopper — so a save has to write both languages at once. An
    // operator editing Spanish copy cannot be asked to switch tabs to make the
    // English shop work.
    const result = buildPayload(
      withVariant({ sizeAmount: "5", sizeUnit: "mg" }),
      messages,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.variants[0]?.name).toEqual({ es: "5 mg", en: "5 mg" });
  });

  it("writes the size into options, which is what keeps two variants distinct", () => {
    // `product_variant_options_unique` is a UNIQUE index on (productId, options)
    // for live rows. This form used to send {} for every variant, so a second
    // one collided and the insert failed as an opaque CONFLICT. The size is what
    // makes the rows differ.
    const result = buildPayload(
      twoVariants({ sizeAmount: "5", sizeUnit: "mg" }, { sizeAmount: "10", sizeUnit: "mg" }),
      messages,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.variants[0]?.options).toEqual({ size: "5 mg" });
    expect(result.value.variants[1]?.options).toEqual({ size: "10 mg" });
  });

  it("refuses two variants that share a size, in the operator's own words", () => {
    const result = buildPayload(
      twoVariants({ sizeAmount: "5", sizeUnit: "mg" }, { sizeAmount: "5", sizeUnit: "mg" }),
      messages,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["variants.1.sizeAmount"]).toBe(messages.sizeDuplicate);
  });

  it("asks for a size only once there is more than one variant", () => {
    const many = buildPayload(twoVariants({}, {}), messages);

    expect(many.ok).toBe(false);
    if (many.ok) return;
    expect(many.errors["variants.0.sizeAmount"]).toBe(messages.sizeRequired);

    // A plain product has no picker to label, so demanding a size from it would
    // be the form inventing a requirement the shop does not have.
    const one = buildPayload(validValues(), messages);
    expect(one.ok).toBe(true);
  });

  it("rejects an amount that is not a number", () => {
    const result = buildPayload(
      withVariant({ sizeAmount: "grande", sizeUnit: "g" }),
      messages,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["variants.0.sizeAmount"]).toBe(messages.sizeNotANumber);
  });

  it("reads a stored size back into the fields", () => {
    const values = toFormValues(buildProduct(), EUR);

    expect(values.variants[0]?.sizeAmount).toBe("10");
    expect(values.variants[0]?.sizeUnit).toBe("mg");
  });

  it("carries a name the size grammar cannot express, rather than erasing it", () => {
    // The guarantee that matters on an edit: a legacy label survives a save by
    // an operator who never looked at the variant.
    const product = buildProduct();
    const [variant] = product.variants;
    if (variant === undefined) {
      throw new Error("buildProduct() must define a variant");
    }
    const legacy: Product = {
      ...product,
      variants: [{ ...variant, name: { es: "Pack de inicio", en: "Starter pack" } }],
    };

    const values = toFormValues(legacy, EUR);
    expect(values.variants[0]?.sizeAmount).toBe("");

    const result = buildPayload(values, messages);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.variants[0]?.name).toEqual({
      es: "Pack de inicio",
      en: "Starter pack",
    });
  });
});

describe("<ProductForm /> simple-product mode", () => {
  it("opens collapsed for a new product, and expanding reveals the size fields", async () => {
    const user = userEvent.setup();
    renderForm(
      <ProductForm
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitCreate}
      />,
    );

    // A plain product is priced, not classified.
    expect(screen.queryByLabelText(form.sizeAmountLabel)).not.toBeInTheDocument();
    // …but its price and stock are reachable without expanding anything.
    expect(screen.getByLabelText(form.skuLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(form.initialStockLabel)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: form.addSizes }));

    expect(screen.getByLabelText(form.sizeAmountLabel)).toBeInTheDocument();
  });

  it("does not count expanding the sizes as an unsaved change", async () => {
    // `variantsExpanded` lives outside `values` precisely so that looking at the
    // panel cannot light the unsaved-changes dot.
    const user = userEvent.setup();
    renderForm(
      <ProductForm
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitCreate}
      />,
    );

    await user.click(screen.getByRole("button", { name: form.addSizes }));

    expect(screen.queryByText(form.unsavedChanges)).not.toBeInTheDocument();
  });

  it("opens expanded for a product whose variant already has a size", () => {
    renderForm(
      <ProductForm
        product={buildProduct()}
        currency={EUR}
        onSubmit={async () => {}}
        submitLabel={form.submitSave}
      />,
    );

    expect(screen.getByLabelText(form.sizeAmountLabel)).toBeInTheDocument();
  });
});
