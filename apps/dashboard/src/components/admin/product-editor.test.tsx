import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { toMinor, type CurrencyCode, type Product } from "@akai/contracts";

import { ToastProvider } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/admin/actions";
import type { ProductCopy } from "@/lib/admin/translate-copy";
import esMessages from "../../../messages/es.json";
import enMessages from "../../../messages/en.json";

/**
 * The translation wiring, from the button to the action and back.
 *
 * WHAT IS ACTUALLY UNDER TEST: that a closed failure reason becomes the right
 * sentence in the operator's own language, and that a deployment with no vendor
 * key degrades to a disabled button beside an explanation rather than to a form
 * that cannot be used. The vendor's own English must never appear.
 */

const translateProductCopyAction =
  vi.fn<(input: unknown) => Promise<ActionResult<ProductCopy>>>();
const createProductAction = vi.fn<(input: unknown) => Promise<unknown>>();
const updateProductAction = vi.fn<(id: string, input: unknown) => Promise<unknown>>();
const addVariantAction = vi.fn<(productId: string, input: unknown) => Promise<unknown>>();
const updateVariantAction =
  vi.fn<(variantId: string, input: unknown) => Promise<unknown>>();
const setVariantInventoryPolicyAction =
  vi.fn<(variantId: string, input: unknown) => Promise<unknown>>();
/** Mocked at the module boundary, so no test does a real presign → PUT → attach. */
const uploadProductImage = vi.fn<(deps: unknown, input: unknown) => Promise<unknown>>();

vi.mock("@/lib/admin/actions", () => ({
  translateProductCopyAction: (input: unknown) => translateProductCopyAction(input),
  createProductAction: (input: unknown) => createProductAction(input),
  updateProductAction: (id: string, input: unknown) => updateProductAction(id, input),
  addVariantAction: (productId: string, input: unknown) =>
    addVariantAction(productId, input),
  updateVariantAction: (variantId: string, input: unknown) =>
    updateVariantAction(variantId, input),
  setVariantInventoryPolicyAction: (variantId: string, input: unknown) =>
    setVariantInventoryPolicyAction(variantId, input),
  deleteProductAction: vi.fn(),
  publishProductAction: vi.fn(),
  unpublishProductAction: vi.fn(),
  createMediaUploadUrlAction: vi.fn(),
  addProductMediaAction: vi.fn(),
  removeProductMediaAction: vi.fn(),
}));

vi.mock("@/lib/admin/upload-product-image", () => ({
  uploadProductImage: (deps: unknown, input: unknown) => uploadProductImage(deps, input),
  // Re-exported because `ImageDropzone` reads it for the file input's `accept`,
  // and a mocked module answers only for what it declares.
  ACCEPTED_IMAGE_TYPES: "image/png,image/jpeg,image/webp",
  MAX_IMAGE_BYTES: 15 * 1024 * 1024,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const { ProductEditor, TRANSLATE_REASON_KEYS } = await import("./product-editor");

const EUR = "EUR" as CurrencyCode;
const ISO = "2026-07-20T10:00:00.000Z";
const form = esMessages.admin.productForm;
const ENGLISH = /English/;

/** The vendor's own prose, of the kind the API logs and never forwards. */
const VENDOR_ENGLISH = "DeepL responded 456: quota exceeded for this billing period.";

function buildProduct(): Product {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "hoodie-kumo",
    status: "ACTIVE",
    taxClass: "STANDARD",
    translations: [
      { locale: "es", name: "Hoodie Kumo", shortDescription: "Sudadera", description: "Descripción" },
    ],
    variants: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        productId: "22222222-2222-4222-8222-222222222222",
        sku: "AK-HOOD-M",
        name: { es: "M / Black", en: "M / Black" },
        // Kept consistent with `name` — real data always derives both from the
        // same size fields, and a mismatch here makes an untouched round trip
        // through `toFormValues`/`buildPayload` look like a variant edit.
        options: { size: "M", color: "Black" },
        price: {
          currency: EUR,
          net: toMinor(4132),
          tax: toMinor(867),
          gross: toMinor(4999),
          compareAtGross: null,
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
    restrictedCountries: [],
    listed: true,
    // Required in the inferred type because `productSchema` DEFAULTS them for
    // rollout safety — a default is applied at parse time, which makes the
    // field mandatory for anything hand-building the shape.
    offerOnNewProducts: false,
    newProductDefaultVariantId: null,
    stackDiscountEnabled: false,
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: null,
  };
}

function renderEditor() {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ProductEditor product={buildProduct()} currency={EUR} />
    </NextIntlClientProvider>,
  );
}

/** Switch to the empty English copy and press translate. */
async function pressTranslate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("radio", { name: ENGLISH }));
  await user.click(
    screen.getByRole("button", { name: form.translate.replace("{language}", "Español") }),
  );
}

beforeEach(() => {
  // Braced: an arrow body returning the mock would register it as a teardown
  // callback, and Vitest would invoke it again after every test.
  translateProductCopyAction.mockReset();
  createProductAction.mockReset();
  updateProductAction.mockReset();
  addVariantAction.mockReset();
  updateVariantAction.mockReset();
  setVariantInventoryPolicyAction.mockReset();
  uploadProductImage.mockReset();
  // jsdom implements neither, and staging a file mints a preview URL for it.
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => undefined;
});

describe("TRANSLATE_REASON_KEYS", () => {
  it("names a real message in BOTH catalogues for every reason", () => {
    // The map is total over the union by construction — the compiler enforces
    // that. What it cannot see is whether the key it names exists: next-intl
    // answers a missing one by printing the key path at an operator.
    const es: Readonly<Record<string, string>> = form.translateErrors;
    const en: Readonly<Record<string, string>> = enMessages.admin.productForm.translateErrors;

    for (const [reason, key] of Object.entries(TRANSLATE_REASON_KEYS)) {
      // The map addresses one namespace, so the leaf is the part after the dot.
      expect(key, reason).toBe(`translateErrors.${reason}`);
      expect(typeof es[reason], `es: ${reason}`).toBe("string");
      // The compiler catches an es-only key; an EN-only one is caught here.
      expect(typeof en[reason], `en: ${reason}`).toBe("string");
    }
  });

  it("gives each reason its own sentence, because each needs a different response", () => {
    // "No key configured" is permanent, "rate limited" is over in seconds and
    // "quota spent" is neither — and all three arrive as one coarse CONFLICT.
    const sentences = Object.values(form.translateErrors);
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});

describe("ProductEditor variant images", () => {
  const WANTED = "33333333-3333-4333-8333-333333333333";

  it("attaches a staged image to the variant with that SKU, not to that position", async () => {
    const user = userEvent.setup();
    createProductAction.mockResolvedValue({
      ok: true,
      data: {
        id: "44444444-4444-4444-8444-444444444444",
        // RETURNED IN THE OTHER ORDER on purpose. An index match would take
        // this first entry, which belongs to a different variant entirely —
        // and nothing would fail, which is what makes it worth a test.
        variants: [
          { id: "55555555-5555-4555-8555-555555555555", sku: "AK-OTHER" },
          { id: WANTED, sku: "AK-HOOD-L" },
        ],
        sanitizedLocales: [],
      },
    });
    uploadProductImage.mockResolvedValue({ ok: true });

    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <ToastProvider closeLabel={esMessages.ui.close}>
          <ProductEditor currency={EUR} />
        </ToastProvider>
      </NextIntlClientProvider>,
    );

    await user.type(screen.getByLabelText(form.slugLabel), "hoodie-kumo");
    await user.type(screen.getByLabelText(form.nameLabel), "Hoodie Kumo");
    await user.type(screen.getByLabelText(form.summaryLabel), "Sudadera");
    await user.type(screen.getByLabelText(form.descriptionLabel), "Descripción");
    await user.type(screen.getByLabelText(form.skuLabel), "AK-HOOD-L");
    await user.type(
      screen.getByLabelText(form.priceLabel.replace("{currency}", EUR)),
      "49.99",
    );

    await user.click(
      screen.getByRole("button", {
        name: esMessages.admin.variantImage.add.replace("{variant}", "AK-HOOD-L"),
      }),
    );
    // SCOPED TO THE DIALOG. The create page carries two dropzones — the product
    // gallery's in the sidebar and this variant's — and they are deliberately
    // the same control with the same wording, so a page-wide query is ambiguous
    // by construction rather than by accident.
    await user.upload(
      within(screen.getByRole("dialog")).getByLabelText(/Arrastra una imagen/),
      new File([new Uint8Array(64)], "tee.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: esMessages.ui.close }));

    // Nothing has been uploaded yet: the presign endpoint is scoped to a
    // productId, which is the whole reason the file was staged.
    expect(uploadProductImage).not.toHaveBeenCalled();

    // The create ends in `window.location.assign`, which jsdom answers with a
    // "Not implemented: navigation" notice on stderr. It is expected, it is not
    // a failure, and it happens AFTER the uploads asserted below — the hard
    // assign is deliberate (see `handleSubmit`), so there is nothing to fix.
    await user.click(screen.getByRole("button", { name: form.submitCreate }));

    await waitFor(() => expect(uploadProductImage).toHaveBeenCalledTimes(1));
    expect(uploadProductImage.mock.calls[0]?.[1]).toMatchObject({
      productId: "44444444-4444-4444-8444-444444444444",
      variantId: WANTED,
    });
  });
});

/**
 * The sanitisation warning — the visible half of the fix for "no lo pone
 * igual": before this, `CONTENT_SANITIZED_HEADER` reached the dashboard and
 * was silently dropped, so an operator whose pasted HTML was rewritten had no
 * way to learn that from the form itself.
 */
describe("ProductEditor — sanitised-description warning", () => {
  it("says nothing after an ordinary create", async () => {
    const user = userEvent.setup();
    createProductAction.mockResolvedValue({
      ok: true,
      data: {
        id: "44444444-4444-4444-8444-444444444444",
        variants: [{ id: "55555555-5555-4555-8555-555555555555", sku: "AK-HOOD-L" }],
        sanitizedLocales: [],
      },
    });

    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <ToastProvider closeLabel={esMessages.ui.close}>
          <ProductEditor currency={EUR} />
        </ToastProvider>
      </NextIntlClientProvider>,
    );

    await user.type(screen.getByLabelText(form.slugLabel), "hoodie-kumo");
    await user.type(screen.getByLabelText(form.nameLabel), "Hoodie Kumo");
    await user.type(screen.getByLabelText(form.summaryLabel), "Sudadera");
    await user.type(screen.getByLabelText(form.descriptionLabel), "Descripción");
    await user.type(screen.getByLabelText(form.skuLabel), "AK-HOOD-L");
    await user.type(
      screen.getByLabelText(form.priceLabel.replace("{currency}", EUR)),
      "49.99",
    );

    await user.click(screen.getByRole("button", { name: form.submitCreate }));

    await waitFor(() => expect(createProductAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(form.descriptionSanitized)).not.toBeInTheDocument();
  });

  it("warns after a create when the API's sanitiser rewrote the description", async () => {
    const user = userEvent.setup();
    createProductAction.mockResolvedValue({
      ok: true,
      data: {
        id: "44444444-4444-4444-8444-444444444444",
        variants: [{ id: "55555555-5555-4555-8555-555555555555", sku: "AK-HOOD-L" }],
        sanitizedLocales: ["es"],
      },
    });

    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <ToastProvider closeLabel={esMessages.ui.close}>
          <ProductEditor currency={EUR} />
        </ToastProvider>
      </NextIntlClientProvider>,
    );

    await user.type(screen.getByLabelText(form.slugLabel), "hoodie-kumo");
    await user.type(screen.getByLabelText(form.nameLabel), "Hoodie Kumo");
    await user.type(screen.getByLabelText(form.summaryLabel), "Sudadera");
    await user.type(screen.getByLabelText(form.descriptionLabel), "<div style='color:blue'>x</div>");
    await user.type(screen.getByLabelText(form.skuLabel), "AK-HOOD-L");
    await user.type(
      screen.getByLabelText(form.priceLabel.replace("{currency}", EUR)),
      "49.99",
    );

    await user.click(screen.getByRole("button", { name: form.submitCreate }));

    expect(await screen.findByText(form.descriptionSanitized)).toBeInTheDocument();
  });

  it("warns after an update when the API's sanitiser rewrote the description", async () => {
    const user = userEvent.setup();
    updateProductAction.mockResolvedValue({
      ok: true,
      data: { id: "22222222-2222-4222-8222-222222222222", sanitizedLocales: ["es", "en"] },
    });

    renderEditor();

    await user.click(screen.getByRole("button", { name: form.submitSave }));

    expect(await screen.findByText(form.descriptionSanitized)).toBeInTheDocument();
    // An untouched variant section makes no variant-level request at all.
    expect(updateVariantAction).not.toHaveBeenCalled();
  });

  it("clears a previous warning on the next save once nothing is rewritten", async () => {
    const user = userEvent.setup();
    updateProductAction
      .mockResolvedValueOnce({
        ok: true,
        data: { id: "22222222-2222-4222-8222-222222222222", sanitizedLocales: ["es"] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { id: "22222222-2222-4222-8222-222222222222", sanitizedLocales: [] },
      });

    renderEditor();

    await user.click(screen.getByRole("button", { name: form.submitSave }));
    expect(await screen.findByText(form.descriptionSanitized)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: form.submitSave }));
    await waitFor(() => expect(updateProductAction).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(form.descriptionSanitized)).not.toBeInTheDocument();
  });
});

describe("ProductEditor translation", () => {
  it("fills the form from the action and saves nothing", async () => {
    const user = userEvent.setup();
    translateProductCopyAction.mockResolvedValue({
      ok: true,
      data: { name: "Hoodie Kumo", shortDescription: "Hoodie", description: "Description" },
    });

    renderEditor();
    await pressTranslate(user);

    await waitFor(() =>
      expect(screen.getByLabelText(form.nameLabel)).toHaveValue("Hoodie Kumo"),
    );
    // The request states its direction rather than leaving the action to infer
    // it: English is on screen, so Spanish is the source.
    expect(translateProductCopyAction).toHaveBeenCalledWith({
      from: "es",
      to: "en",
      copy: {
        name: "Hoodie Kumo",
        shortDescription: "Sudadera",
        description: "Descripción",
      },
    });
    // PREFILLED, NOT SAVED, and marked as nobody's work yet.
    expect(screen.getByText(form.machineTranslated)).toBeInTheDocument();
  });

  it("translates the reason into the operator's language, never the vendor's", async () => {
    const user = userEvent.setup();
    translateProductCopyAction.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      reason: "QUOTA_EXCEEDED",
      message: VENDOR_ENGLISH,
    });

    renderEditor();
    await pressTranslate(user);

    expect(
      await screen.findByText(form.translateErrors.QUOTA_EXCEEDED),
    ).toBeInTheDocument();
    expect(screen.queryByText(VENDOR_ENGLISH)).toBeNull();
    // The coarse code's sentence would have said "conflicts with the current
    // state", which tells an operator nothing about a spent allowance.
    expect(screen.queryByText(esMessages.errors.CONFLICT)).toBeNull();
  });

  it("says the session expired for UNAUTHENTICATED, regardless of the reason", async () => {
    // NOT the sign-in-flavoured `errors.UNAUTHENTICATED` — see `messageFor`'s
    // own note on why that copy was wrong here (item §3's fix). This reason
    // string is not even a real one (translate-copy reasons and auth-failure
    // reasons are different enums); the point is that `messageFor` decides on
    // `code` for this one, not on parsing `reason` first.
    const user = userEvent.setup();
    translateProductCopyAction.mockResolvedValue({
      ok: false,
      code: "UNAUTHENTICATED",
      reason: "VENDOR_ON_FIRE",
      message: VENDOR_ENGLISH,
    });

    renderEditor();
    await pressTranslate(user);

    expect(
      await screen.findByText(esMessages.admin.common.sessionExpired),
    ).toBeInTheDocument();
    expect(screen.queryByText(esMessages.errors.UNAUTHENTICATED)).toBeNull();
    expect(screen.queryByText(VENDOR_ENGLISH)).toBeNull();
  });

  it("disables translation for the rest of the page once the key is missing", async () => {
    const user = userEvent.setup();
    translateProductCopyAction.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      reason: "NOT_CONFIGURED",
      message: "No DEEPL_API_KEY is configured.",
    });

    renderEditor();
    await pressTranslate(user);

    expect(
      await screen.findByText(form.translateErrors.NOT_CONFIGURED),
    ).toBeInTheDocument();
    // No retry can fix it while this page is open, so the affordance stands
    // down instead of failing identically on every press.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: form.translate.replace("{language}", "Español") }),
      ).toBeDisabled(),
    );
    // DEGRADED, NOT BROKEN: saving still works, and the copy fields still take
    // typing.
    expect(screen.getByRole("button", { name: form.submitSave })).toBeEnabled();
    await user.type(screen.getByLabelText(form.nameLabel), "Hand-written");
    expect(screen.getByLabelText(form.nameLabel)).toHaveValue("Hand-written");
  });
});

/**
 * The fix for item 1d: editing an existing variant's fields, or adding a new
 * one, on the product edit page now actually saves — previously the whole
 * variants section of this form was a silent no-op on update.
 */
describe("ProductEditor — existing-variant edits and new-variant creation", () => {
  it("saves an existing variant's price through updateVariantAction, carrying its version", async () => {
    const user = userEvent.setup();
    updateProductAction.mockResolvedValue({
      ok: true,
      data: { id: "22222222-2222-4222-8222-222222222222", sanitizedLocales: [] },
    });
    updateVariantAction.mockResolvedValue({ ok: true, data: null });

    renderEditor();

    const price = screen.getByLabelText(form.priceLabel.replace("{currency}", EUR));
    await user.clear(price);
    await user.type(price, "59.99");

    await user.click(screen.getByRole("button", { name: form.submitSave }));

    await waitFor(() => expect(updateVariantAction).toHaveBeenCalledTimes(1));
    expect(updateVariantAction).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ version: 3, priceGross: 5999 }),
    );
    // The product-level save is what an operator watches for, and it must
    // still read as a plain success — nothing here failed.
    expect(screen.queryByText(form.variantSaveFailed)).not.toBeInTheDocument();
    expect(screen.queryByText(form.variantConflict)).not.toBeInTheDocument();
  });

  it("surfaces a stale-version conflict without erasing the product-level save", async () => {
    const user = userEvent.setup();
    updateProductAction.mockResolvedValue({
      ok: true,
      data: { id: "22222222-2222-4222-8222-222222222222", sanitizedLocales: [] },
    });
    updateVariantAction.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      reason: null,
      message: "Variant was modified by another write; refetch and retry",
    });

    renderEditor();

    const price = screen.getByLabelText(form.priceLabel.replace("{currency}", EUR));
    await user.clear(price);
    await user.type(price, "59.99");

    await user.click(screen.getByRole("button", { name: form.submitSave }));

    expect(await screen.findByText(form.variantConflict)).toBeInTheDocument();
    // The product's own fields still saved — a variant conflict is reported
    // separately, never as "nothing was saved".
    expect(updateProductAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(form.variantSaveFailed)).not.toBeInTheDocument();
  });

  it("creates a brand-new variant row and attaches its staged photo to the id the server minted", async () => {
    const user = userEvent.setup();
    updateProductAction.mockResolvedValue({
      ok: true,
      data: { id: "22222222-2222-4222-8222-222222222222", sanitizedLocales: [] },
    });
    const NEW_VARIANT_ID = "66666666-6666-4666-8666-666666666666";
    addVariantAction.mockResolvedValue({
      ok: true,
      data: { id: NEW_VARIANT_ID, sku: "AK-HOOD-L" },
    });
    uploadProductImage.mockResolvedValue({ ok: true });

    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <ToastProvider closeLabel={esMessages.ui.close}>
          <ProductEditor product={buildProduct()} currency={EUR} />
        </ToastProvider>
      </NextIntlClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: form.addVariant }));

    const rows = screen.getAllByTestId("variant-row");
    expect(rows).toHaveLength(2);
    const newRow = within(rows[1] as HTMLElement);

    await user.type(newRow.getByLabelText(form.skuLabel), "AK-HOOD-L");
    await user.type(
      newRow.getByLabelText(form.priceLabel.replace("{currency}", EUR)),
      "39.99",
    );
    // A size is required once there is more than one variant, and it must not
    // collide with the existing row's "M / Black".
    await user.type(newRow.getByLabelText(form.sizeLabel), "L");
    await user.type(newRow.getByLabelText(form.colorLabel), "Black");

    await user.click(
      newRow.getByRole("button", {
        name: esMessages.admin.variantImage.add.replace("{variant}", "AK-HOOD-L"),
      }),
    );
    await user.upload(
      within(screen.getByRole("dialog")).getByLabelText(/Arrastra una imagen/),
      new File([new Uint8Array(64)], "tee.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: esMessages.ui.close }));

    await user.click(screen.getByRole("button", { name: form.submitSave }));

    await waitFor(() => expect(addVariantAction).toHaveBeenCalledTimes(1));
    expect(addVariantAction).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({ sku: "AK-HOOD-L", priceGross: 3999 }),
    );
    await waitFor(() => expect(uploadProductImage).toHaveBeenCalledTimes(1));
    expect(uploadProductImage.mock.calls[0]?.[1]).toMatchObject({
      productId: "22222222-2222-4222-8222-222222222222",
      variantId: NEW_VARIANT_ID,
    });
    // An existing row untouched alongside the new one makes no update call.
    expect(updateVariantAction).not.toHaveBeenCalled();
  });
});

/**
 * §3's secondary bug: `messageFor` used to branch on `code` alone, so
 * `FORBIDDEN`'s two very different real causes (a stale 2FA proof, an account
 * with none enrolled) and a truly dead session both showed the same
 * sign-in-flavoured sentence written for the wrong form. Exercised on the
 * UPDATE save path — the one the original bug report was actually about.
 */
describe("ProductEditor — error messages route on reason, not just code", () => {
  it("says the session expired for UNAUTHENTICATED — not the sign-in-flavoured generic copy", async () => {
    const user = userEvent.setup();
    updateProductAction.mockResolvedValue({
      ok: false,
      code: "UNAUTHENTICATED",
      reason: null,
      message: "jwt expired",
    });

    renderEditor();
    await user.click(screen.getByRole("button", { name: form.submitSave }));

    expect(
      await screen.findByText(esMessages.admin.common.sessionExpired),
    ).toBeInTheDocument();
    expect(screen.queryByText(esMessages.errors.UNAUTHENTICATED)).toBeNull();
  });

  it("names the 2FA-freshness gate specifically, reusing AdminErrorState's own copy", async () => {
    const user = userEvent.setup();
    updateProductAction.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
      reason: "TWO_FACTOR_REQUIRED",
      message: "Two-factor authentication required",
    });

    renderEditor();
    await user.click(screen.getByRole("button", { name: form.submitSave }));

    expect(
      await screen.findByText(esMessages.admin.common.twoFactorBody),
    ).toBeInTheDocument();
    expect(screen.queryByText(esMessages.errors.FORBIDDEN)).toBeNull();
  });

  it("names the no-second-factor-enrolled case specifically", async () => {
    const user = userEvent.setup();
    updateProductAction.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
      reason: "TWO_FACTOR_ENROLMENT_REQUIRED",
      message: "Two-factor authentication required",
    });

    renderEditor();
    await user.click(screen.getByRole("button", { name: form.submitSave }));

    expect(
      await screen.findByText(esMessages.admin.common.enrolmentBody),
    ).toBeInTheDocument();
  });

  it("falls back to the coarse FORBIDDEN sentence for a plain permission failure", async () => {
    const user = userEvent.setup();
    updateProductAction.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
      reason: null,
      message: "Insufficient role",
    });

    renderEditor();
    await user.click(screen.getByRole("button", { name: form.submitSave }));

    expect(await screen.findByText(esMessages.errors.FORBIDDEN)).toBeInTheDocument();
  });
});
