"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import {
  computeStackDiscountTiers,
  createProductSchema,
  STACK_DISCOUNT_BEST_PRICE_QUANTITY,
  type Category,
  type CreateProduct,
  type CreateVariant,
  type CurrencyCode,
  type Locale,
  type PriceTier,
  type Product,
  type ProductAddOnInput,
} from "@akai/contracts";
import { formatMoney, toMinor } from "@akai/money";
import { sanitizeRichText } from "@akai/rich-text";

import { Button, IconButton } from "@/components/ui/button";
import { MoneyField, PopupButton, TextArea, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import type { StagedImage } from "@/components/ui/media-uploader";
import { Notice } from "@/components/ui/notice";
import { Checkbox } from "@/components/ui/toggle";
import {
  formatMinorAsInput,
  parseMajorUnitInput,
  type MoneyInputError,
} from "@/lib/admin/money-input";
import type { SetInventoryPolicyRequest, UpdateVariantRequest } from "@/lib/admin/schemas";

import { AddOnPicker, type AddOnCandidate } from "./add-on-picker";
import { PackComponentsPicker, type PackComponentCandidate } from "./pack-components-picker";
import {
  ProductPreviewDialog,
  type PreviewAddOn,
  type PreviewImage,
  type PreviewStock,
  type PreviewVariant,
} from "./product-preview-dialog";
import { VariantImageField, type VariantImageSupport } from "./variant-image";

/**
 * Create/edit form for a product and its variants — the largest form in the app.
 *
 * THREE RULES GOVERN THIS FILE.
 *
 * 1. It validates against `createProductSchema` from @akai/contracts — the SAME
 *    schema the API parses the request with. Not a hand-written mirror of it.
 *    A client-side copy of a server rule drifts the first time either side is
 *    edited, and the failure mode is a form that cheerfully accepts input the
 *    API then rejects with a 400 the operator cannot act on.
 *
 * 2. Prices are entered in MAJOR units and stored in MINOR units, converted only
 *    through `parseMajorUnitInput`. There is no `* 100` in this file and there
 *    must never be one: see money-input.ts for why the float route silently
 *    loses cents.
 *
 * 3. EVERY `Panel` IS A `<fieldset disabled={submitting}>` WITH A `<legend>`,
 *    and that is a mechanism rather than a paint choice. `disabled` on a
 *    fieldset disables every control inside it, which is how the whole form
 *    freezes during a submit without threading a prop through forty inputs; the
 *    legend is the group name a screen reader announces before each field.
 *    Rewriting a panel as a `<div>` with an `<h2>` looks identical, silently
 *    un-freezes the form, and removes the group name — so the freeze is
 *    asserted directly in `product-form.test.tsx` rather than left to review,
 *    across a text field, a table cell AND the locale switch.
 *
 * WHAT THE DENSITY PASS CHANGED, AND WHY.
 *
 * The form was ~2000px tall for an empty product with one variant, so no
 * operator ever saw the whole thing at once. Two things made it that tall.
 *
 * FIRST, THE COPY WAS WRITTEN TWICE ON SCREEN. Spanish and English sat in two
 * side-by-side cards, each with Name, Summary and Description — six controls
 * for three pieces of information. They are now ONE field set behind a locale
 * switch. The reason the pair existed was visibility ("the English is behind"),
 * and that is preserved rather than dropped: each segment carries its own
 * completeness indicator, so an empty English is legible WITHOUT switching to
 * it. Both locales stay in `values.translations` the whole time — switching a
 * segment changes which draft is rendered and nothing else, so what was typed
 * in the other language cannot be lost.
 *
 * SECOND, ONE VARIANT COST SIX STACKED LABELLED FIELDS. It is now one table
 * row: the column header carries the label, the cell carries the control. The
 * labels did not disappear — every input still has its own (`labelHidden`
 * keeps it in the accessibility tree and out of the pixels), because a column
 * header alone is not an accessible name for a screen reader moving cell by
 * cell, and each row additionally carries a `<th scope="row">` naming which
 * variant it is.
 *
 * There is NO sync column and no sync anything: the catalog mirror is deleted,
 * and under Whop an unmirrored variant is not a thing that exists.
 *
 * Client-side validation is a COURTESY, never a control. The API re-validates
 * everything with the same schema plus `.strict()`, and recomputes every price
 * server-side. Nothing here is load-bearing for security.
 */

/** Form-local variant state. Every field is a string: that is what an input holds. */
/**
 * One volume-pricing tier, AS TYPED.
 *
 * Both fields are strings for the reason every other money and count field in
 * this form is: an operator mid-keystroke has typed "1" on the way to "10", and
 * a number-typed state would round-trip that through `Number` and fight the
 * cursor. They are parsed once, on submit, by `buildPayload`.
 *
 * `key` is a render key only. Tiers have no server id — they are replaced
 * wholesale on save — so a list index would reorder inputs under the operator's
 * cursor when a row above is removed.
 */
interface TierDraft {
  readonly key: string;
  /** The quantity the tier price starts applying at. The contract requires >= 2. */
  readonly minQuantity: string;
  /** MAJOR units as typed, e.g. "49.49". The substitute unit price, not a discount. */
  readonly unitPriceGross: string;
}

interface VariantDraft {
  readonly key: string;
  /**
   * The server's optimistic-concurrency token for an EXISTING variant — `0`,
   * and never read, for a row added on the edit page (`classifyVariantChanges`
   * routes those to `addVariant`, which does not take one at all).
   */
  readonly version: number;
  readonly sku: string;
  /**
   * The variant's per-locale name — CARRIED, NOT SHOWN.
   *
   * There is no input for it, and that is deliberate rather than an omission:
   * the value round-trips through `toFormValues` → `buildVariantName` so that
   * saving an untouched form cannot erase a name the form never displayed. The
   * artboard draws a "Nombre" column for it; the message catalogue has no label
   * for one, so the input is a follow-up and the erasure is not.
   */
  readonly nameEs: string;
  readonly nameEn: string;
  /**
   * The size on the label — "M", "XL", "42", "One size" — and an optional
   * colour ("Black"), both free text as typed.
   *
   * THIS IS WHAT MAKES A VARIANT PICKER APPEAR. The storefront hides the picker
   * when every variant label is null (`product-purchase-panel.tsx`), and the
   * label comes from `variant.name`, which this form never had an input for. So
   * every product built here shipped with unnamed variants and no way to choose
   * between them. Size (and colour, when set) fills that name, in both locales,
   * on submit, and becomes the variant's `options` — `{ size, color }`.
   */
  readonly size: string;
  readonly color: string;
  /** MAJOR units as typed, e.g. "49.99". Converted on submit, never on keystroke. */
  readonly priceGross: string;
  readonly compareAtGross: string;
  readonly weightGrams: string;
  readonly initialStock: string;
  readonly lowStockThreshold: string;
  readonly allowBackorder: boolean;
  /**
   * A file chosen for this variant BEFORE the product exists, or none.
   *
   * Only ever set while creating. An existing variant's image is read from the
   * `product` prop instead of being copied in here, and deliberately so: a live
   * upload is written on the server and the page refreshes, so a copy seeded
   * once into form state would still say "no image" beside a picture that is
   * already stored.
   */
  readonly stagedImage: StagedImage | null;
  /**
   * Volume pricing for this variant. Empty is one price at every quantity,
   * which is every variant that existed before the tier table.
   *
   * THIS IS WHAT MAKES THE FEATURE REAL. The contract, the cart and the product
   * page have all resolved tiers since they shipped; with no input here every
   * variant carried an empty array, so the resolver always returned the base
   * price and the whole path was inert.
   */
  readonly priceTiers: readonly TierDraft[];
}

interface TranslationDraft {
  readonly locale: Locale;
  readonly name: string;
  readonly shortDescription: string;
  readonly description: string;
}

export interface ProductFormValues {
  readonly slug: string;
  readonly status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  readonly taxClass: "STANDARD" | "REDUCED" | "ZERO_RATED";
  /**
   * Whether the shop's product listing shows this product.
   *
   * A BOOLEAN, not a second status. `status` already owns DRAFT/ACTIVE/ARCHIVED,
   * and the question here is a different, closed and binary one: an ACTIVE
   * add-on is a real, purchasable product that simply is not in the index. Two
   * overlapping enums would produce ACTIVE+HIDDEN with no defined winner.
   */
  readonly listed: boolean;
  /**
   * Offer this product as an add-on on every product created FROM NOW ON.
   *
   * PRODUCT STATE, so it lives here and is saved with the product — unlike
   * "offer on every existing product", which is an ACTION taken once and kept
   * outside these values so ticking it is not an unsaved change.
   */
  readonly offerOnNewProducts: boolean;
  /** Which variant those automatic edges pre-select. Settable only when editing. */
  readonly newProductDefaultVariantId: string | null;
  /**
   * Every variant's tiers are the fixed, non-configurable stack-discount
   * schedule (`computeStackDiscountTiers`), computed from that variant's OWN
   * price — nobody types a percentage or a price for it. While on, the
   * freeform tier editor below is replaced with a read-only preview of the
   * same computation, and `buildPayload` submits the computed schedule
   * instead of whatever the freeform rows would have held.
   */
  readonly stackDiscountEnabled: boolean;
  readonly currency: CurrencyCode;
  /**
   * SIMPLE (default) is directly sellable. PACK means this product's own
   * variant carries a display price only, and the price-tier panel below is
   * replaced by the pack-components picker. Add-ons are unaffected — a pack
   * can offer them on its own page exactly like a SIMPLE product can.
   */
  readonly kind: "SIMPLE" | "PACK";
  /**
   * The 2–6 products a PACK is made of, each with its pinned variant. Always
   * `[]` for a SIMPLE product — `buildPayload` never sends it unless
   * `kind === "PACK"`, so this array existing on a SIMPLE product's draft
   * state is harmless, but keeping it empty here means the picker never has
   * to reconcile stale selections against a kind that no longer wants them.
   */
  readonly packComponents: readonly {
    readonly id: string;
    readonly variantId: string;
    readonly quantity: number;
  }[];
  /**
   * The add-ons this product's page offers, in the operator's order.
   *
   * ENTRIES, AND THE ORDER IS THE VALUE. The array's position becomes the
   * edge's `sortOrder` server-side, so this is a list rather than a set —
   * ticking a box appends, and re-ordering here re-orders the strip in the shop.
   *
   * Each entry also names the variant that host page PRE-SELECTS, which is a
   * fact about the pair rather than about either product.
   */
  readonly addOns: readonly ProductAddOnInput[];
  /**
   * The categories this product belongs to. UNORDERED — `sortOrder` on
   * `ProductCategory` is the CATEGORY's position on this product's page for
   * its own related-products rail, a fact the picker below has no UI for yet;
   * `buildPayload` submits this array in whatever order the operator ticked
   * the boxes, which the API accepts and assigns positionally the same way
   * `addOns` above does. See `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`
   * §6 — this replaces a hardcoded `categoryIds: []` that made category
   * assignment silently do nothing from this form.
   */
  readonly categoryIds: readonly string[];
  readonly translations: readonly TranslationDraft[];
  readonly variants: readonly VariantDraft[];
}

/**
 * The translated copy `buildPayload` needs, passed IN rather than looked up.
 *
 * `buildPayload` is a pure function with its own tests, so it cannot call a
 * hook — and it must not fall back to an English default either, because a
 * default that works is a default nobody replaces. The component assembles this
 * from `admin.common.moneyErrors` (a total `Record` over the parser's closed
 * failure union) and `admin.productForm.fieldErrors`, so a new failure mode is
 * a compile error here rather than a blank message beside a mispriced product.
 */
export interface ProductFormMessages {
  readonly money: Readonly<Record<MoneyInputError, string>>;
  readonly compareAtTooLow: string;
  readonly notAWholeNumber: string;
  readonly notWholeGrams: string;
  readonly sizeRequired: string;
  readonly sizeDuplicate: string;
  readonly tierQuantityInvalid: string;
  readonly tierDuplicate: string;
  readonly tierPriceTooHigh: string;
}

/** One locale's product copy — the three fields the copy panel edits. */
export interface ProductCopyDraft {
  readonly name: string;
  readonly shortDescription: string;
  readonly description: string;
}

/**
 * What the form asks a translator for.
 *
 * `from` is the locale the operator is NOT looking at and `to` is the one on
 * screen, because the button reads "Traducir desde Español" while the English
 * fields are visible: the direction is stated in the label, so it must be
 * stated in the request rather than inferred by the handler.
 */
export interface TranslateCopyRequest {
  readonly from: Locale;
  readonly to: Locale;
  readonly copy: ProductCopyDraft;
}

/**
 * The translation seam.
 *
 * A PROP, not a call. This component may not reach the API — every network call
 * in the admin surface goes through a server action owned by the client
 * boundary above it (`ProductEditor`), which is also where a failure code is
 * turned into a translated sentence. The form only knows how to ask, how to
 * wait, and where to put the answer.
 *
 * A rejection is caught, never re-thrown. It is reported as the handler's own
 * sentence when it rejects with a `TranslateCopyError` — the only shape that
 * promises an already-translated string — and as this form's `translateFailed`
 * for anything else, because any other `Error.message` here is written for a
 * log and rule 9 keeps it away from an operator.
 */
export type TranslateCopy = (request: TranslateCopyRequest) => Promise<ProductCopyDraft>;

/**
 * A translation failure whose message an operator may READ.
 *
 * The same mechanism as `ConfirmActionError` in `ui/confirm`, and for the same
 * reason. Only the seam's owner (`ProductEditor`) can turn a closed failure
 * code into a sentence from the message catalogue, and a rejected promise
 * carries nothing but an `Error`; `instanceof` is what separates that already
 * translated sentence from an incidental `Error` whose message is the API's own
 * English. Rule 9 governs the second, so the form swaps it for `translateFailed`
 * rather than printing it.
 */
export class TranslateCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslateCopyError";
  }
}

/**
 * The translated copy, NARROWED rather than trusted.
 *
 * `TranslateCopy` says the handler resolves with three strings, but the value
 * crosses a network boundary before it gets here and a promise's type parameter
 * is an assertion, not a proof. A missing `description` would land `undefined`
 * in a controlled input — React then switches the field to uncontrolled and the
 * operator's next keystroke is silently unmanaged. Parsing turns that into a
 * visible "could not translate" instead.
 *
 * EXPORTED so the handler can parse at its own boundary with the same schema
 * rather than writing a second one. The form parses again regardless: two
 * parses of a three-field object cost nothing, and the form cannot know whether
 * the handler it was given did the first one.
 *
 * NOT `.strict()`: that rule is for REQUEST schemas, where an unknown field is
 * an injection surface. Here an extra field is a newer server saying more than
 * we asked for, and dropping it is the right answer.
 */
export const productCopySchema = z.object({
  name: z.string(),
  shortDescription: z.string(),
  description: z.string(),
});

/**
 * "Also offer this add-on on every existing product", as the form reports it.
 *
 * A THIRD ARGUMENT TO `onSubmit`, not a field on the payload: it is a SECOND
 * write against a different endpoint, and only the caller knows whether the
 * first one succeeded. The form states the intent; the editor decides when —
 * and whether — to act on it.
 */
export interface OfferEverywhereIntent {
  readonly everywhere: boolean;
  /**
   * Which variant every host pre-selects. Null while CREATING, always: the
   * variants have no ids until the product exists, and naming one before then
   * would mean inventing it. The edit page is where a default is chosen.
   */
  readonly defaultVariantId: string | null;
}

export interface ProductFormProps {
  /** Absent for create. Present for edit, and seeds every field. */
  readonly product?: Product;
  readonly currency: CurrencyCode;
  /**
   * Receives a payload that has ALREADY been parsed by `createProductSchema`,
   * so the callback cannot be handed an unvalidated shape.
   *
   * THE SECOND ARGUMENT carries the variant images staged in this form, which
   * exist only while creating: the presign endpoint is scoped to a productId, so
   * nothing can be uploaded until the caller has created the product and can
   * say which variant each file belongs to. It is a second parameter rather than
   * a field on the payload because the payload is the contract's `CreateProduct`
   * and a `File` is not part of that contract.
   *
   * THE FOURTH ARGUMENT is `undefined` while creating and populated while
   * editing — `value.variants` is not usable for an edit at all
   * (`updateProductAction` deletes that key: an existing variant carries a
   * server `version` this shape has no room for, and a brand-new row added
   * during the edit has no id to PATCH in the first place). `classifyVariantChanges`
   * is what tells the two apart; this form computes it, because it is the only
   * place that still has each row's original key and stored counterpart once
   * `buildPayload` has flattened both into one `CreateProduct`.
   */
  readonly onSubmit: (
    value: CreateProduct,
    variantImages: readonly StagedVariantImage[],
    offer?: OfferEverywhereIntent,
    variantChanges?: ClassifiedVariantChanges,
  ) => Promise<void>;
  readonly submitLabel: string;
  /**
   * Supply it and the copy panel grows a "translate from the other language"
   * button. Absent — the current state — and the panel renders exactly as it
   * does today, so the seam costs nothing until it is wired.
   */
  readonly onTranslate?: TranslateCopy;
  /**
   * Why translation cannot run on this deployment at all, already translated.
   *
   * Set only for a refusal no retry can fix — no vendor key configured. The
   * button then stays visible and DISABLED beside this one line, and every
   * other control on the form keeps working: an operator told "it is not
   * configured" writes the copy by hand, where one pressing a button that
   * silently does nothing does not.
   */
  readonly translateUnavailable?: string;
  /**
   * The images control, rendered in the sidebar under the product settings.
   *
   * A SLOT rather than a built-in, because the two callers need different
   * behaviour: creating stages files until the product has an id, editing
   * uploads immediately against one that already exists. The form owns where
   * images sit; it does not own how they are stored.
   */
  readonly mediaSlot?: ReactNode;
  /**
   * Turns on the variant table's image column, and says how it behaves.
   *
   * ABSENT MEANS NO COLUMN AT ALL, rather than a disabled one: the column costs
   * horizontal room in a table whose density is the reason it is a table, and a
   * caller that cannot upload has nothing to put in it. Like `mediaSlot`, the
   * form owns WHERE a variant image sits and never how it is stored — every
   * network call in the admin surface belongs to the client boundary above.
   */
  readonly variantImages?: VariantImageSupport;
  /**
   * Product-level images the caller has STAGED but not uploaded, for the eye
   * preview. Only ever set while creating — an existing product's pictures are
   * read from `product.media`, which this form already receives.
   */
  readonly previewImages?: readonly StagedImage[];
  /**
   * The products that MAY be offered as add-ons — the unlisted ones.
   *
   * ABSENT MEANS NO PANEL, rather than an empty one: the candidates are fetched
   * by the page, and a caller that has not fetched them has nothing to offer.
   * The form owns where the picker sits; it never fetches, the same division
   * `mediaSlot` and `variantImages` already draw.
   */
  readonly addOnCandidates?: readonly AddOnCandidate[];
  /**
   * The products that MAY be pinned as a pack's components — every live
   * product that is not itself a pack. Same "absent means no panel"
   * convention as `addOnCandidates` immediately above, and the same reason:
   * the page fetches, the form only renders.
   */
  readonly packComponentCandidates?: readonly PackComponentCandidate[];
  /**
   * The initial `kind` for a brand-new product, from a query hint
   * (`?kind=PACK`) on the "New product" page's own link from the packs list.
   * Ignored once `product` is defined — an existing row's own `kind` always
   * wins.
   */
  readonly initialKind?: "SIMPLE" | "PACK";
  /**
   * Every live category, for the assignment checklist below.
   *
   * ABSENT MEANS NO PANEL, same convention as `addOnCandidates` and
   * `mediaSlot`: the page fetches the category tree (`GET /admin/categories`,
   * behind auth), and this form only renders what it is handed. Fixes the
   * `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md` §6
   * finding that category assignment silently did nothing from this form —
   * `buildPayload` used to submit a hardcoded empty `categoryIds`.
   */
  readonly categories?: readonly Category[];
  /** Shown in the save bar — a reminder of what saving will do. */
  readonly helperText?: string;
  /** Rendered above the actions — e.g. an API error from a failed save. */
  readonly formError?: string | undefined;
}

/** Field-path → message. Keyed by the same dotted path zod reports. */
type FieldErrors = Readonly<Record<string, string>>;

/**
 * A language is named in its own language, here and in the drawn artboard.
 *
 * NOT translated, and not a message key: "Español" is "Español" to an English
 * reader picking which language to fill in, exactly as a language switcher
 * never says "Spanish / Inglés". The FIELD labels stay in the operator's own
 * locale — they describe the form, not the content.
 */
const LANGUAGE_NAME: Readonly<Record<Locale, string>> = {
  es: "Español",
  en: "English",
};

/** Spanish first, because it is the storefront's default and the source copy. */
const LOCALE_ORDER: readonly Locale[] = ["es", "en"];

const DEFAULT_LOCALE: Locale = "es";

const PRODUCT_STATUSES: readonly ProductFormValues["status"][] = [
  "DRAFT",
  "ACTIVE",
  "ARCHIVED",
];

const TAX_CLASSES: readonly ProductFormValues["taxClass"][] = [
  "STANDARD",
  "REDUCED",
  "ZERO_RATED",
];

/**
 * The listing choice as the sidebar spells it — which is NOT how the column
 * spells it, and deliberately so. The operator picks between two named
 * outcomes; nobody has to know the word `listed`.
 *
 * TWO NAMED OPTIONS RATHER THAN A CHECKBOX. An unchecked box called "Listed"
 * says only what the product is not, and the state that matters here — "this is
 * an add-on, reached from another product's page" — deserves a name an operator
 * can read without inverting anything. `PopupButton` is generic over a string
 * union and hands back the option's own literal rather than the DOM's `string`,
 * so the boolean is mapped at the control and mapped back on change, in one
 * place each.
 */
const LISTING_MODES = ["LISTED", "ADDON"] as const;

/**
 * Simple/Pack, the way an operator reads it — never the word `kind`.
 *
 * TWO NAMED OPTIONS, same reasoning `LISTING_MODES` gives immediately above:
 * "this is a pack of several products" is a fact the operator picks, not a
 * flag they toggle.
 */
const PRODUCT_KINDS = ["SIMPLE", "PACK"] as const;

export function ProductForm({
  mediaSlot,
  variantImages,
  previewImages,
  addOnCandidates,
  packComponentCandidates,
  initialKind,
  categories,
  helperText = "",
  product,
  currency,
  onSubmit,
  onTranslate,
  translateUnavailable,
  submitLabel,
  formError,
}: ProductFormProps) {
  const t = useTranslations("admin.productForm");
  const tCommon = useTranslations("admin.common");
  const tStatus = useTranslations("status");
  const tUi = useTranslations("ui");
  const formId = useId();

  /**
   * The values the form OPENED with, kept so the save bar can say whether
   * anything has actually changed. Seeded once by the state initialiser: a prop
   * that arrives again after a server re-render must not silently redefine what
   * "unsaved" means while the operator is typing.
   */
  const [initial] = useState<ProductFormValues>(() =>
    toFormValues(product, currency, initialKind),
  );
  const [values, setValues] = useState<ProductFormValues>(initial);
  /**
   * Whether the size fields and the add-a-variant control are on screen.
   *
   * HELD OUTSIDE `values`, exactly as `activeLocale` is, and for the same
   * reason: `dirty` is a structural compare of `values`, so a disclosure kept in
   * there would light the "Cambios sin guardar" dot for merely looking at the
   * panel. This is a view of variant 1, never a second model of it — collapsed
   * and expanded bind the same fields, so nothing is copied and nothing is
   * synthesised on submit.
   */
  const [variantsExpanded, setVariantsExpanded] = useState(() =>
    shouldOpenVariants(initial),
  );
  const variantsRegionId = useId();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  /** Fallback for a rejecting `onSubmit` the parent did not surface itself. */
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Which locale's copy is on screen. Never which locales EXIST in state. */
  const [activeLocale, setActiveLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [translating, setTranslating] = useState(false);
  /** The last failure as a sentence the operator may read, or null. */
  const [translateError, setTranslateError] = useState<string | null>(null);
  /**
   * Locales whose copy a machine wrote and no human has read since.
   *
   * A LIST OF LOCALES, not a boolean: the panel shows one language at a time,
   * so "this text is a machine's guess" has to survive a switch away and back,
   * and has to be visible on the segment of the locale that is off screen.
   */
  const [machineFilled, setMachineFilled] = useState<readonly Locale[]>([]);
  /**
   * "Offer this add-on on every product", and which variant they pre-select.
   *
   * HELD OUTSIDE `ProductFormValues` on purpose, exactly as `variantsExpanded`
   * is: `dirty` compares the value object structurally, so anything parked in
   * there would report an unsaved change for merely ticking a box that belongs
   * to a different write.
   */
  const [offerEverywhere, setOfferEverywhere] = useState(false);
  /** A translate press held back because the target already has copy in it. */
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const messages: ProductFormMessages = {
    // Spelled out rather than derived from a key map, because a total `Record`
    // over `MoneyInputError` is the thing that fails to compile when the parser
    // grows a seventh failure mode.
    money: {
      EMPTY: tCommon("moneyErrors.EMPTY"),
      NOT_A_NUMBER: tCommon("moneyErrors.NOT_A_NUMBER"),
      GROUPING_SEPARATOR: tCommon("moneyErrors.GROUPING_SEPARATOR"),
      NEGATIVE: tCommon("moneyErrors.NEGATIVE"),
      TOO_MANY_DECIMALS: tCommon("moneyErrors.TOO_MANY_DECIMALS"),
      TOO_LARGE: tCommon("moneyErrors.TOO_LARGE"),
    },
    compareAtTooLow: t("fieldErrors.COMPARE_AT_TOO_LOW"),
    notAWholeNumber: t("fieldErrors.NOT_A_WHOLE_NUMBER"),
    notWholeGrams: t("fieldErrors.NOT_WHOLE_GRAMS"),
    sizeRequired: t("fieldErrors.SIZE_REQUIRED"),
    sizeDuplicate: t("fieldErrors.SIZE_DUPLICATE"),
    tierQuantityInvalid: t("fieldErrors.TIER_QUANTITY_INVALID"),
    tierDuplicate: t("fieldErrors.TIER_DUPLICATE"),
    tierPriceTooHigh: t("fieldErrors.TIER_PRICE_TOO_HIGH"),
  };

  // More than one variant means the sizes are what tell them apart, so they are
  // never hidden; the collapse is only ever offered to a single-variant product.
  // Hiding a filled field is how data is lost.
  const multiVariant = values.variants.length > 1;
  const sizesShown = variantsExpanded || multiVariant;

  // What the preview draws, resolved to the locale on screen. Staged files carry
  // the object URL `MediaUploader` already minted and revokes — minting a second
  // one here would leak it.
  const previewImageList: readonly PreviewImage[] =
    previewImages !== undefined && previewImages.length > 0
      ? previewImages.map((image) => ({
          url: image.previewUrl,
          alt: activeLocale === "es" ? image.altEs : image.altEn,
        }))
      : (product?.media ?? []).map((asset) => ({
          url: asset.url,
          alt: asset.alt[activeLocale] ?? "",
        }));

  const previewVariants: readonly PreviewVariant[] = values.variants.map((variant) => {
    const price = parseMajorUnitInput(variant.priceGross, values.currency);
    const compareRaw = variant.compareAtGross.trim();
    const compare =
      compareRaw === "" ? null : parseMajorUnitInput(compareRaw, values.currency);
    const size = variantSize(variant);
    const carried = activeLocale === "es" ? variant.nameEs.trim() : variant.nameEn.trim();

    // The shop's four states and its threshold of five, mirrored.
    const typed = Number(variant.initialStock.trim());
    const onHand = Number.isFinite(typed) ? typed : 0;
    const stock: PreviewStock =
      onHand <= 0
        ? variant.allowBackorder
          ? "backorder"
          : "soldOut"
        : onHand <= 5
          ? "lowStock"
          : "inStock";

    // A STAGED file while creating; the STORED image while editing. `VariantDraft`
    // deliberately never carries the stored one — it is read from `product` at
    // render time so a live upload shows without a remount — so the preview has
    // to look it up the same way.
    const stored =
      product?.variants.find((row) => row.id === variant.key)?.image?.url ?? null;

    return {
      key: variant.key,
      sku: variant.sku.trim(),
      label:
        size !== null
          ? sizeLabel(size)
          : carried === ""
            ? null
            : carried,
      priceGross: price.ok ? price.value : null,
      compareAtGross: compare !== null && compare.ok ? compare.value : null,
      imageUrl: variant.stagedImage?.previewUrl ?? stored,
      stock,
      // A HALF-TYPED TIER SIMPLY DOES NOT APPEAR. The preview answers "what will
      // this look like?", and a row for `minQuantity: ""` would answer it with a
      // table the shop could never draw. `buildPayload` is what reports the
      // mistake, beside the field, on submit.
      priceTiers: variant.priceTiers.flatMap((tier) => {
        const quantityRaw = tier.minQuantity.trim();
        const parsed = parseMajorUnitInput(tier.unitPriceGross, values.currency);
        return /^\d+$/.test(quantityRaw) && Number(quantityRaw) >= 2 && parsed.ok
          ? [{ minQuantity: Number(quantityRaw), unitPriceGross: parsed.value }]
          : [];
      }),
    };
  });

  // IN THE OPERATOR'S ORDER, because the array's position is what becomes the
  // edge's `sortOrder` — so the strip below previews the arrangement that will
  // actually be saved.
  const previewAddOns: readonly PreviewAddOn[] =
    addOnCandidates === undefined
      ? []
      : values.addOns.flatMap((entry) => {
          const candidate = addOnCandidates.find((row) => row.id === entry.id);
          return candidate === undefined
            ? []
            : [
                {
                  id: candidate.id,
                  name: candidate.name,
                  priceGross: candidate.priceGross ?? null,
                  currency: candidate.currency ?? null,
                  // EVERY variant, so the preview draws the offer the shop
                  // draws — "3 ml Gratis / 10 ml 8,45 €" rather than one price
                  // standing in for a choice.
                  variants: candidate.variants ?? [],
                },
              ];
        });

  const dirty = !sameValues(values, initial);
  const activeCopy = translationFor(values, activeLocale);
  const sourceLocale = otherLocale(activeLocale);
  const sourceCopy = translationFor(values, sourceLocale);

  // The pack's own flat price, parsed — a pack has exactly one variant, so
  // this is always `values.variants[0]`. Feeds the components picker's
  // running-total hint; `null` while the field is empty or unparseable, which
  // simply suppresses the hint rather than blocking the picker.
  const firstVariantPrice = parseMajorUnitInput(
    values.variants[0]?.priceGross ?? "",
    values.currency,
  );
  const packPriceGross = firstVariantPrice.ok ? firstVariantPrice.value : null;

  /**
   * The variants the SERVER holds, by id — which is the row key for a variant
   * that already exists.
   *
   * Rebuilt from the prop on every render rather than copied into state. A live
   * variant upload is written on the server and the page refreshes, so the
   * freshest answer to "does this variant have an image?" is the prop; state
   * seeded once by `toFormValues` would still say no.
   */
  const storedVariants = new Map(
    (product?.variants ?? []).map((variant) => [variant.id, variant] as const),
  );

  function updateVariant(key: string, patch: Partial<VariantDraft>): void {
    setValues((current) => ({
      ...current,
      variants: current.variants.map((variant) =>
        variant.key === key ? { ...variant, ...patch } : variant,
      ),
    }));
  }

  function updateTranslation(locale: Locale, patch: Partial<TranslationDraft>): void {
    setValues((current) => ({
      ...current,
      translations: current.translations.map((translation) =>
        translation.locale === locale ? { ...translation, ...patch } : translation,
      ),
    }));
  }

  /** Drop the unreviewed marker: a human has now taken responsibility for it. */
  function markReviewed(locale: Locale): void {
    setMachineFilled((current) => current.filter((entry) => entry !== locale));
  }

  /**
   * An operator's own keystroke, as distinct from a machine fill.
   *
   * Both end in `updateTranslation`; only this one clears the marker. Clearing
   * inside `updateTranslation` itself would be simpler and wrong — the fill
   * calls it too, and would erase the very warning it just raised.
   */
  function editTranslation(locale: Locale, patch: Partial<TranslationDraft>): void {
    markReviewed(locale);
    updateTranslation(locale, patch);
  }

  /**
   * One row's image control, or nothing when this form cannot store one.
   *
   * THE NAME IS THE POINT. A column header does not name a cell for a screen
   * reader moving cell by cell, so a column of buttons all called "Añadir
   * imagen" is a column of buttons called nothing useful. The SKU is what the
   * operator typed and what identifies the row to them; until they have typed
   * one, the row heading is the only name that tells two of these apart.
   */
  function variantImageCell(variant: VariantDraft, index: number): ReactNode {
    if (variantImages === undefined) {
      return null;
    }

    const sku = variant.sku.trim();
    const variantName = sku === "" ? t("variantHeading", { index: index + 1 }) : sku;

    if (variantImages.mode === "staged") {
      return (
        <VariantImageField
          mode="staged"
          variantName={variantName}
          image={variant.stagedImage}
          onChange={(image) => updateVariant(variant.key, { stagedImage: image })}
        />
      );
    }

    const stored = storedVariants.get(variant.key);
    if (stored === undefined) {
      // A row ADDED on the edit page has no variant id YET — `addVariantAction`
      // mints one only once the save round-trips — so it stages exactly like a
      // row on the create form does, and `applyVariantChanges` uploads it once
      // the new id comes back, keyed by the same SKU match the create flow uses.
      return (
        <VariantImageField
          mode="staged"
          variantName={variantName}
          image={variant.stagedImage}
          onChange={(image) => updateVariant(variant.key, { stagedImage: image })}
        />
      );
    }

    return (
      <VariantImageField
        mode="live"
        variantName={variantName}
        variantId={stored.id}
        asset={stored.image}
        uploads={variantImages.uploads}
      />
    );
  }

  function addVariant(): void {
    setValues((current) => ({
      ...current,
      variants: [...current.variants, emptyVariant()],
    }));
  }

  function removeVariant(key: string): void {
    setValues((current) =>
      // A product must keep at least one variant: the variant is the sellable
      // unit, so removing the last one leaves a product nothing can be bought
      // from. The schema's `.min(1)` would reject it anyway; refusing here means
      // the operator is not told about it only after a round trip.
      current.variants.length <= 1
        ? current
        : {
            ...current,
            variants: current.variants.filter((variant) => variant.key !== key),
          },
    );
  }

  /**
   * The press. Runs the translation, or asks first.
   *
   * NEVER CLOBBER WRITTEN COPY. A vendor's guess can be asked for again; a
   * paragraph an operator typed cannot, and there is no undo on this form. So a
   * target with any text in it costs one extra press, and a blank one — the
   * ordinary case, and the whole point of the feature — costs none.
   */
  function requestTranslate(): void {
    setTranslateError(null);

    if (isBlankCopy(activeCopy)) {
      void handleTranslate();
      return;
    }
    setConfirmOverwrite(true);
  }

  async function handleTranslate(): Promise<void> {
    if (onTranslate === undefined || translating) {
      return;
    }

    setConfirmOverwrite(false);
    setTranslateError(null);
    setTranslating(true);
    try {
      const parsed = productCopySchema.safeParse(
        await onTranslate({
          from: sourceLocale,
          to: activeLocale,
          copy: {
            name: sourceCopy.name,
            shortDescription: sourceCopy.shortDescription,
            description: sourceCopy.description,
          },
        }),
      );

      if (!parsed.success) {
        setTranslateError(t("translateFailed"));
        return;
      }

      updateTranslation(activeLocale, parsed.data);
      // MARKED, not silently merged. What follows is a machine's guess sitting
      // in the same boxes as the operator's own prose, and the two are
      // indistinguishable once they are on screen.
      setMachineFilled((current) =>
        current.includes(activeLocale) ? current : [...current, activeLocale],
      );
    } catch (cause) {
      // A `TranslateCopyError` was written for an operator by the seam's owner,
      // which is the only side that can name the failure. Anything else carries
      // server-authored English, and rule 9 keeps that away from the form.
      setTranslateError(
        cause instanceof TranslateCopyError ? cause.message : t("translateFailed"),
      );
    } finally {
      setTranslating(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const built = buildPayload(values, messages);
    if (!built.ok) {
      setErrors(built.errors);

      // The copy panel shows ONE locale at a time, so a rejected save whose only
      // problem is in the hidden language would look like a form that refuses to
      // submit for no reason. Switching to the offending locale puts the error
      // where the operator is already looking — and only when the visible locale
      // is itself clean, so a switch never hides an error they can see.
      if (!hasCopyError(built.errors, activeLocale)) {
        const offending = LOCALE_ORDER.find((locale) => hasCopyError(built.errors, locale));
        if (offending !== undefined) {
          setActiveLocale(offending);
        }
      }
      return;
    }

    setErrors({});
    setSubmitError(null);
    setSubmitting(true);
    try {
      // The staged files are tagged with the SKU that is being submitted in the
      // same call, so the caller matches them onto the created variants by a
      // value the operator typed rather than by array position.
      await onSubmit(
        built.value,
        stagedVariantImages(values),
        {
          everywhere: offerEverywhere,
          // ONE selector serves both: the fan-out that runs now and the flag that
          // catches future products. "Offer the water everywhere, 3 ml free" is a
          // single decision, and two controls for it would invite them to differ.
          defaultVariantId: product === undefined ? null : values.newProductDefaultVariantId,
        },
        // Only meaningful once a product already exists — see `onSubmit`'s own
        // doc comment for why `value.variants` cannot be used for this instead.
        product === undefined
          ? undefined
          : classifyVariantChanges(values, product, built.value.variants),
      );
    } catch (cause) {
      // CAUGHT, not merely re-thrown into the void. `handleSubmit` is an async
      // DOM event handler, so a rejection escaping here becomes an unhandled
      // promise rejection: no error boundary sees it, the operator is shown
      // nothing, and the form looks like it saved. Surfacing it locally means a
      // parent that already renders `formError` still works, and one that
      // forgets to catch does not silently lose the failure.
      setSubmitError(cause instanceof Error ? cause.message : t("saveFailed"));
    } finally {
      // Reset even on failure: leaving the button disabled would strand the
      // operator with no way to retry.
      setSubmitting(false);
    }
  }

  const shownError = formError ?? submitError ?? undefined;

  return (
    <form onSubmit={handleSubmit} noValidate aria-describedby={`${formId}-error`}>
      {/* TWO COLUMNS, and the sidebar is a FIXED 320 rather than a fraction: it
          holds a slug, two pop-ups and a thumbnail strip, none of which reads
          better for being wider, and pinning it means the copy and the variant
          table take every pixel the window adds. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="grid min-w-0 gap-4">
          {/* THE COPY, ONCE. The legend names the language being edited, so the
              group a screen reader announces before "Nombre" says which
              language that name is for — and it changes only when the operator
              switches, never on a keystroke. */}
          <Panel
            title={t("sectionCopy", { language: LANGUAGE_NAME[activeLocale] })}
            disabled={submitting}
            actions={
              <>
                <LocaleSwitch
                  label={t("localeSwitch")}
                  name={`${formId}-copy-locale`}
                  value={activeLocale}
                  onChange={setActiveLocale}
                  status={(locale) => {
                    const empty = emptyFieldCount(translationFor(values, locale));
                    const machine = machineFilled.includes(locale);
                    return {
                      empty,
                      machine,
                      // The sentence a screen reader hears, which is also the
                      // one a sighted operator reads as a count chip. The
                      // default-locale note rides along for free: it costs no
                      // pixels and it is the fact that explains why Spanish is
                      // first.
                      text: [
                        locale === DEFAULT_LOCALE ? t("defaultLocale") : null,
                        empty > 0 ? t("emptyFields", { count: empty }) : t("localeComplete"),
                        // Said on the segment as well as in the panel, so the
                        // fact survives a switch to the other language — which
                        // is exactly when an operator forgets it.
                        machine ? t("machineTranslatedShort") : null,
                      ]
                        .filter((part): part is string => part !== null)
                        .join(". "),
                    };
                  }}
                />
                {onTranslate === undefined ? null : (
                  <Button
                    variant="standard"
                    size="compact"
                    onClick={requestTranslate}
                    pending={translating}
                    pendingLabel={t("translating")}
                    // Two reasons to stand down, both of them permanent until
                    // something changes: an empty source can only translate to
                    // nothing, and a deployment with no vendor key configured
                    // cannot translate at all.
                    disabled={isBlankCopy(sourceCopy) || translateUnavailable !== undefined}
                  >
                    {t("translate", { language: LANGUAGE_NAME[sourceLocale] })}
                  </Button>
                )}
              </>
            }
          >
            <div className="grid gap-2">
              {/* DEGRADED, NOT BROKEN. `translateUnavailable` outranks the
                  failure notice because it arrives WITH one: the press that
                  discovered the missing key also rejected, and saying "it did
                  not work" under "it is not configured here" is the same fact
                  twice, the second time less usefully. */}
              {translateUnavailable !== undefined ? (
                <Notice tone="warning" placement="inline">
                  {translateUnavailable}
                </Notice>
              ) : translateError === null ? null : (
                <Notice tone="danger" placement="inline">
                  {translateError}
                </Notice>
              )}
              {confirmOverwrite && (
                <Notice
                  tone="warning"
                  placement="inline"
                  action={
                    <>
                      <Button variant="standard" size="compact" onClick={() => void handleTranslate()}>
                        {t("translateOverwriteConfirm")}
                      </Button>
                      <Button
                        variant="plain"
                        size="compact"
                        onClick={() => setConfirmOverwrite(false)}
                      >
                        {tUi("cancel")}
                      </Button>
                    </>
                  }
                >
                  {t("translateOverwrite", { language: LANGUAGE_NAME[activeLocale] })}
                </Notice>
              )}
              {machineFilled.includes(activeLocale) && (
                // WHO WROTE THIS TEXT, stated where the text is. An operator who
                // cannot tell their own copy from a vendor's guess publishes the
                // guess — and this is the copy customers read and the shop
                // stands behind.
                <Notice
                  tone="warning"
                  placement="inline"
                  action={
                    <Button
                      variant="standard"
                      size="compact"
                      onClick={() => markReviewed(activeLocale)}
                    >
                      {t("markReviewed")}
                    </Button>
                  }
                >
                  {t("machineTranslated")}
                </Notice>
              )}
              {/* KEYED BY LOCALE. Without the key React reuses the same input
                  instances across a switch, and an uncommitted IME composition
                  or a mid-word caret from the Spanish field survives into the
                  English one. */}
              <TextField
                key={`name-${activeLocale}`}
                label={t("nameLabel")}
                name={`name-${activeLocale}`}
                value={activeCopy.name}
                onChange={(value) => editTranslation(activeLocale, { name: value })}
                {...optionalError(errors[`translations.${activeLocale}.name`])}
              />
              <TextField
                key={`summary-${activeLocale}`}
                label={t("summaryLabel")}
                name={`summary-${activeLocale}`}
                value={activeCopy.shortDescription}
                onChange={(value) =>
                  editTranslation(activeLocale, { shortDescription: value })
                }
                {...optionalError(errors[`translations.${activeLocale}.shortDescription`])}
              />
              {/* THE DESCRIPTION IS MARKUP NOW, and there is deliberately no
                  rich-text editor behind it: the operator types or pastes HTML.
                  What they do need is to see what they will get — which is
                  `ProductPreviewDialog`, behind the eye beside the submit
                  button, not a preview under this field. A per-field preview
                  only answers "is my HTML valid?"; the dialog draws the whole
                  card the way the storefront actually will, which is the
                  question an operator has (see the commit that moved it). */}
              <TextArea
                key={`description-${activeLocale}`}
                label={t("descriptionLabel")}
                name={`description-${activeLocale}`}
                rows={3}
                hint={t("descriptionHint")}
                value={activeCopy.description}
                onChange={(value) => editTranslation(activeLocale, { description: value })}
                {...optionalError(errors[`translations.${activeLocale}.description`])}
              />
              {/* APPENDS RATHER THAN INSERTS AT THE CURSOR. `TextArea` exposes
                  no ref for cursor position, and adding one for a single button
                  would be a larger, unrelated change — see `libs/rich-text`'s
                  own note on this being a closed preset, not a rich editor. */}
              <Button
                variant="plain"
                size="compact"
                onClick={() =>
                  editTranslation(activeLocale, {
                    description: `${activeCopy.description}\n<hr class="divider--accent">\n`,
                  })
                }
              >
                {t("insertDivider")}
              </Button>
            </div>
          </Panel>

          {/* PRODUCT-LEVEL, gating the variant tier UI directly below it: a
              product either has manually-entered tiers or this fixed schedule,
              never both, so the toggle sits where its effect is visible.

              ABSENT FOR A PACK, same reasoning as the tier block itself below:
              its one variant carries the flat pack price, and there is nothing
              here for this toggle to gate once that block is hidden. */}
          {values.kind !== "PACK" && (
          <Panel
            title={t("stackDiscountTitle")}
            description={t("stackDiscountHint")}
            disabled={submitting}
          >
            <div className="grid gap-2">
              <Checkbox
                label={t("stackDiscountEnabled")}
                name="stack-discount-enabled"
                checked={values.stackDiscountEnabled}
                onChange={(checked) =>
                  setValues((current) => ({ ...current, stackDiscountEnabled: checked }))
                }
              />
              {values.stackDiscountEnabled && (
                <p className="text-[11px] leading-4 text-[var(--label-secondary)]">
                  {t("stackDiscountScheduleNote")}
                </p>
              )}
            </div>
          </Panel>
          )}

          <Panel
            title={t("variantsTitle")}
            description={t("variantsHint")}
            disabled={submitting}
            {...(multiVariant
              ? {}
              : {
                  actions: (
                    <Button
                      variant="standard"
                      size="compact"
                      icon={variantsExpanded ? "chevron-down" : "chevron-right"}
                      aria-expanded={variantsExpanded}
                      aria-controls={variantsRegionId}
                      onClick={() => setVariantsExpanded((open) => !open)}
                    >
                      {variantsExpanded ? t("hideSizes") : t("addSizes")}
                    </Button>
                  ),
                })}
          >
            {/* CARDS, NOT A TABLE, and the width is the whole reason.
                Eight controls needed `min-w-[700px]`, which overflowed the panel
                on any laptop, and the size pair would have added two more columns
                to a row already scrolling. A card per variant lets the fields
                REFLOW instead of scroll, and lets every label be visible rather
                than `labelHidden` under a column header that no longer exists.

                EACH CARD IS A NESTED <fieldset> WITH A <legend>. That keeps this
                file's opening rule true twice over: the nested fieldset inherits
                `disabled` from the Panel, so the submit freeze still applies with
                no prop threading, and the legend names the group the way
                <th scope="row"> used to. */}
            <ul id={variantsRegionId} className="grid gap-3">
              {values.variants.map((variant, index) => (
                <li key={variant.key} data-testid="variant-row">
                  <fieldset className="m-0 min-w-0 rounded-[var(--r-control)] border border-[var(--separator-weak)] p-3">
                    <legend className="px-1 text-[11px] font-semibold text-[var(--label-secondary)]">
                      {t("variantHeading", { index: index + 1 })}
                    </legend>

                    <div className="flex items-start gap-2">
                      {variantImageCell(variant, index)}
                      {values.variants.length > 1 && (
                        <IconButton
                          label={t("removeVariant")}
                          icon="trash-2"
                          variant="destructivePlain"
                          size="mini"
                          className="ms-auto"
                          onClick={() => removeVariant(variant.key)}
                        />
                      )}
                    </div>

                    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {sizesShown && (
                        <>
                          <TextField
                            label={t("sizeLabel")}
                            name={`size-${variant.key}`}
                            value={variant.size}
                            onChange={(value) => updateVariant(variant.key, { size: value })}
                            {...optionalError(errors[`variants.${index}.size`])}
                          />
                          <TextField
                            label={t("colorLabel")}
                            name={`color-${variant.key}`}
                            value={variant.color}
                            onChange={(value) => updateVariant(variant.key, { color: value })}
                            {...optionalError(errors[`variants.${index}.color`])}
                          />
                        </>
                      )}
                      <TextField
                        label={t("skuLabel")}
                        name={`sku-${variant.key}`}
                        value={variant.sku}
                        onChange={(value) => updateVariant(variant.key, { sku: value })}
                        mono
                        {...optionalError(errors[`variants.${index}.sku`])}
                      />
                      <MoneyField
                        label={t("priceLabel", { currency })}
                        name={`price-${variant.key}`}
                        value={variant.priceGross}
                        currency={currency}
                        onChange={(next) =>
                          updateVariant(variant.key, { priceGross: next.raw })
                        }
                        errorMessages={messages.money}
                        {...optionalError(errors[`variants.${index}.priceGross`])}
                      />
                      <MoneyField
                        label={t("compareAtLabel")}
                        name={`compare-${variant.key}`}
                        value={variant.compareAtGross}
                        currency={currency}
                        onChange={(next) =>
                          updateVariant(variant.key, { compareAtGross: next.raw })
                        }
                        errorMessages={messages.money}
                        {...optionalError(errors[`variants.${index}.compareAtGross`])}
                      />
                      <TextField
                        label={t("initialStockLabel")}
                        name={`stock-${variant.key}`}
                        value={variant.initialStock}
                        inputMode="numeric"
                        onChange={(value) =>
                          updateVariant(variant.key, { initialStock: value })
                        }
                        // DISABLED FOR AN EXISTING ROW, EDITABLE FOR A NEW ONE.
                        // On-hand is a ledger balance changed by a signed delta
                        // plus a mandatory reason (the page's own "Ajustar
                        // stock" control), not a number this save flow can just
                        // overwrite — `classifyVariantChanges` never reads this
                        // field for a stored row, so leaving the input live
                        // here would show a value that quietly does nothing.
                        // A brand-new row has no stock ledger yet, so its
                        // number is a real starting value `addVariant` accepts.
                        {...(storedVariants.has(variant.key)
                          ? { disabled: true, hint: t("stockReadOnlyHint") }
                          : {})}
                        {...optionalError(errors[`variants.${index}.initialStock`])}
                      />
                      <TextField
                        label={t("thresholdLabel")}
                        name={`threshold-${variant.key}`}
                        value={variant.lowStockThreshold}
                        inputMode="numeric"
                        onChange={(value) =>
                          updateVariant(variant.key, { lowStockThreshold: value })
                        }
                        {...optionalError(errors[`variants.${index}.lowStockThreshold`])}
                      />
                      <TextField
                        label={t("weightLabel")}
                        name={`weight-${variant.key}`}
                        value={variant.weightGrams}
                        hint={t("weightHint")}
                        inputMode="numeric"
                        onChange={(value) =>
                          updateVariant(variant.key, { weightGrams: value })
                        }
                        {...optionalError(errors[`variants.${index}.weightGrams`])}
                      />
                    </div>

                    <div className="mt-2">
                      <Checkbox
                        label={t("allowBackorder")}
                        checked={variant.allowBackorder}
                        onChange={(checked) =>
                          updateVariant(variant.key, { allowBackorder: checked })
                        }
                        name={`backorder-${variant.key}`}
                      />
                    </div>

                    {/* VOLUME TIERS. Collapsed to a single button until one is
                        added, because most products have none and an empty
                        two-column grid reads as a field somebody forgot to fill.
                        Mutations go through `updateVariant` rather than their own
                        helpers: the tier list is a field OF the variant, and a
                        second mutation path is how the two states drift.

                        ABSENT ENTIRELY FOR A PACK. Its one variant carries the
                        flat pack price, and a per-quantity discount on top of a
                        price that is already a discount off the components has
                        no sensible reading — `buildPayload` submits an empty
                        `priceTiers` for it regardless of whatever this panel
                        last held, so hiding it is display only. */}
                    {values.kind !== "PACK" && (
                    <div className="mt-3 rounded-[var(--r-control)] border border-dashed border-[var(--separator-weak)] p-2">
                      <p className="px-1 text-[11px] font-semibold text-[var(--label-secondary)]">
                        {t("tiersLabel")}
                      </p>
                      <p className="mt-0.5 px-1 text-[11px] leading-4 text-[var(--label-secondary)]">
                        {values.stackDiscountEnabled ? t("stackDiscountHint") : t("tiersHint")}
                      </p>

                      {values.stackDiscountEnabled ? (
                        // READ-ONLY: nothing here is typed. The same
                        // `computeStackDiscountTiers` call the API makes when it
                        // persists this variant previews here, so this list and
                        // the charged price cannot drift apart.
                        <ul className="mt-2 grid gap-1">
                          {stackDiscountPreview(variant, values.currency).map((tier) => (
                            <li
                              key={tier.minQuantity}
                              className="flex items-center justify-between rounded-[var(--r-control)] bg-[var(--bg-grouped)] px-2 py-1 text-[12px] text-[var(--label)]"
                            >
                              <span>
                                {tier.minQuantity} ×{" "}
                                {formatMoney(tier.unitPriceGross, values.currency, activeLocale)}
                              </span>
                              {tier.minQuantity === STACK_DISCOUNT_BEST_PRICE_QUANTITY && (
                                <span className="text-[10px] font-semibold tracking-wide text-[var(--accent)] uppercase">
                                  {t("bestPriceBadge")}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <>
                          {variant.priceTiers.length > 0 && (
                            <ul className="mt-2 grid gap-2">
                              {variant.priceTiers.map((tier, tierIndex) => (
                                <li key={tier.key} className="flex items-start gap-2">
                                  <div className="grid flex-1 gap-2 sm:grid-cols-3">
                                    <TextField
                                      label={t("tierQuantityLabel")}
                                      name={`tier-qty-${tier.key}`}
                                      value={tier.minQuantity}
                                      inputMode="numeric"
                                      onChange={(value) =>
                                        updateVariant(variant.key, {
                                          priceTiers: variant.priceTiers.map((row) =>
                                            row.key === tier.key
                                              ? { ...row, minQuantity: value }
                                              : row,
                                          ),
                                        })
                                      }
                                      {...optionalError(
                                        errors[
                                          `variants.${index}.priceTiers.${tierIndex}.minQuantity`
                                        ],
                                      )}
                                    />
                                    <TextField
                                      label={t("tierPercentLabel")}
                                      name={`tier-percent-${tier.key}`}
                                      value={tierPercent(variant, tier, values.currency)}
                                      hint={t("tierPercentHint")}
                                      inputMode="numeric"
                                      onChange={(value) => {
                                        const priced = tierPriceFromPercent(
                                          variant,
                                          value,
                                          values.currency,
                                        );
                                        if (priced === null) return;
                                        updateVariant(variant.key, {
                                          priceTiers: variant.priceTiers.map((row) =>
                                            row.key === tier.key
                                              ? { ...row, unitPriceGross: priced }
                                              : row,
                                          ),
                                        });
                                      }}
                                    />
                                    <MoneyField
                                      label={t("tierPriceLabel", { currency })}
                                      name={`tier-price-${tier.key}`}
                                      value={tier.unitPriceGross}
                                      currency={currency}
                                      onChange={(next) =>
                                        updateVariant(variant.key, {
                                          priceTiers: variant.priceTiers.map((row) =>
                                            row.key === tier.key
                                              ? { ...row, unitPriceGross: next.raw }
                                              : row,
                                          ),
                                        })
                                      }
                                      errorMessages={messages.money}
                                      {...optionalError(
                                        errors[
                                          `variants.${index}.priceTiers.${tierIndex}.unitPriceGross`
                                        ],
                                      )}
                                    />
                                  </div>
                                  <IconButton
                                    label={t("removeTier")}
                                    icon="trash-2"
                                    variant="destructivePlain"
                                    size="mini"
                                    onClick={() =>
                                      updateVariant(variant.key, {
                                        priceTiers: variant.priceTiers.filter(
                                          (row) => row.key !== tier.key,
                                        ),
                                      })
                                    }
                                  />
                                </li>
                              ))}
                            </ul>
                          )}

                          <div className="mt-2">
                            <Button
                              variant="standard"
                              size="compact"
                              icon="plus"
                              onClick={() =>
                                updateVariant(variant.key, {
                                  priceTiers: [...variant.priceTiers, emptyTier()],
                                })
                              }
                            >
                              {t("addTier")}
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                    )}
                  </fieldset>
                </li>
              ))}
              {sizesShown && (
                <li>
                  <Button
                    variant="standard"
                    size="compact"
                    icon="plus"
                    onClick={addVariant}
                  >
                    {t("addVariant")}
                  </Button>
                </li>
              )}
            </ul>
          </Panel>

          {categories === undefined ? null : (
            <Panel
              title={t("categoriesTitle")}
              description={t("categoriesHint")}
              disabled={submitting}
            >
              {categories.length === 0 ? (
                <p className="text-[13px] text-[var(--label-secondary)]">
                  {t("categoriesEmpty")}
                </p>
              ) : (
                <div className="grid gap-2">
                  {categories.map((category) => (
                    <Checkbox
                      key={category.id}
                      label={category.name[activeLocale] ?? category.slug}
                      name={`category-${category.id}`}
                      checked={values.categoryIds.includes(category.id)}
                      onChange={(checked) =>
                        setValues((current) => ({
                          ...current,
                          categoryIds: checked
                            ? [...current.categoryIds, category.id]
                            : current.categoryIds.filter((id) => id !== category.id),
                        }))
                      }
                    />
                  ))}
                </div>
              )}
            </Panel>
          )}

          {/* PACK COMPONENTS, ALONGSIDE ADD-ONS — NOT INSTEAD OF THEM. A
              pack's own variant is never sold (the picker below is what the
              pack actually needs), but the pack PRODUCT ITSELF can still
              offer add-ons on its own page exactly like any SIMPLE product —
              "would you also like a sticker pack with this pack?" is a perfectly
              normal upsell. `ProductAddOn` and `ProductPackComponent` are
              independent tables end to end (see `ProductPackComponent`'s
              schema comment), so there is no backend reason to keep these
              panels mutually exclusive; they used to be, which was a UI gap
              a pack could never actually use, not a rule. */}
          {values.kind === "PACK" &&
            packComponentCandidates !== undefined && (
              <Panel
                title={t("packComponentsTitle")}
                description={t("packComponentsHint")}
                disabled={submitting}
              >
                <PackComponentsPicker
                  candidates={packComponentCandidates}
                  selected={values.packComponents}
                  locale={activeLocale}
                  currency={values.currency}
                  packPriceGross={packPriceGross}
                  onChange={(packComponents) =>
                    setValues((current) => ({ ...current, packComponents }))
                  }
                />
              </Panel>
            )}
          {addOnCandidates !== undefined && (
            <Panel
              title={t("addOnsTitle")}
              description={t("addOnsHint")}
              disabled={submitting}
            >
              <AddOnPicker
                candidates={addOnCandidates}
                selected={values.addOns}
                locale={activeLocale}
                onChange={(addOns) => setValues((current) => ({ ...current, addOns }))}
              />
            </Panel>
          )}

          {/* THE OTHER DIRECTION. The panel above chooses what THIS page
              offers; this one offers THIS product on everyone else's page, and
              it only makes sense for a product that is itself an add-on. */}
          {!values.listed && (
            <Panel
              title={t("offerEverywhere")}
              description={t("offerEverywhereHint")}
              disabled={submitting}
            >
              <div className="grid gap-2">
                {/* AN ACTION: runs once, against the products that exist now. */}
                <Checkbox
                  label={t("offerEverywhere")}
                  name="offer-everywhere"
                  checked={offerEverywhere}
                  onChange={setOfferEverywhere}
                />
                {/* A SETTING: saved with the product, and applied to every
                    product created afterwards. Deliberately a second control
                    rather than one that means both — an operator attaching this
                    to today's catalogue has not necessarily decided anything
                    about tomorrow's. */}
                <Checkbox
                  label={t("offerNewProducts")}
                  name="offer-new-products"
                  checked={values.offerOnNewProducts}
                  onChange={(checked) =>
                    setValues((current) => ({ ...current, offerOnNewProducts: checked }))
                  }
                />
                <p className="text-[11px] leading-4 text-[var(--label-secondary)]">
                  {t("offerNewProductsHint")}
                </p>
                {/* ONLY WHEN EDITING. While creating, the variants have no ids
                    yet, so there is nothing to name — the operator sets a
                    default afterwards, on this same form. */}
                {(offerEverywhere || values.offerOnNewProducts) &&
                  product !== undefined &&
                  product.variants.length > 0 && (
                  <PopupButton<string>
                    label={t("defaultVariantLabel")}
                    name="offer-everywhere-default"
                    value={values.newProductDefaultVariantId ?? ""}
                    options={[
                      { value: "", label: t("defaultVariantNone") },
                      ...product.variants
                        .filter((variant) => variant.isActive)
                        .map((variant) => ({
                          value: variant.id,
                          label:
                            variant.price.gross === 0
                              ? `${variant.name?.[activeLocale] ?? variant.sku} · ${t("defaultVariantFree")}`
                              : `${variant.name?.[activeLocale] ?? variant.sku} · ${formatMoney(variant.price.gross, variant.price.currency, activeLocale)}`,
                        })),
                    ]}
                    onChange={(id) =>
                      setValues((current) => ({
                        ...current,
                        newProductDefaultVariantId: id === "" ? null : id,
                      }))
                    }
                  />
                )}
              </div>
            </Panel>
          )}
        </div>

        {/* SIDEBAR. Slug, status and tax class are set once and rarely revisited,
            and the images are chosen once; keeping both out of the main flow
            stops them competing with the copy and the pricing an operator is
            actually here to write. */}
        <aside className="grid min-w-0 gap-4">
          <Panel title={t("productTitle")} disabled={submitting}>
            <div className="grid gap-2">
              <TextField
                label={t("slugLabel")}
                name="slug"
                value={values.slug}
                hint={t("slugHint")}
                mono
                onChange={(value) => setValues((current) => ({ ...current, slug: value }))}
                {...optionalError(errors["slug"])}
              />

              {/* `PopupButton` hands back the option's own literal type — it
                  looks the selected value up among the options it rendered
                  rather than casting the DOM's `string` — so no narrowing
                  helper is needed and a renamed option is a compile error. */}
              <PopupButton
                label={t("statusLabel")}
                name="status"
                value={values.status}
                options={PRODUCT_STATUSES.map((status) => ({
                  value: status,
                  label: tStatus(`product.${status}`),
                }))}
                onChange={(status) => setValues((current) => ({ ...current, status }))}
                {...optionalError(errors["status"])}
              />

              <PopupButton
                label={t("taxClassLabel")}
                name="taxClass"
                value={values.taxClass}
                options={TAX_CLASSES.map((taxClass) => ({
                  value: taxClass,
                  label: t(`taxClasses.${taxClass}`),
                }))}
                onChange={(taxClass) => setValues((current) => ({ ...current, taxClass }))}
                {...optionalError(errors["taxClass"])}
              />

              {/* BESIDE STATUS AND TAX CLASS, not in the variants table: whether
                  the shop lists a product is a fact about the PRODUCT, and a
                  per-variant answer to it has no meaning — the listing shows one
                  card per product.

                  The hint states the consequence, because "add-on" alone does
                  not tell an operator that the product stays purchasable: it
                  keeps its own page and its own Add to cart, and only leaves the
                  index. Without that sentence the safe reading is "this hides
                  it", and nobody would ever pick it. */}
              <PopupButton
                label={t("listingLabel")}
                name="listing"
                value={values.listed ? "LISTED" : "ADDON"}
                hint={t("listingHint")}
                options={LISTING_MODES.map((mode) => ({
                  value: mode,
                  label: t(`listingModes.${mode}`),
                }))}
                onChange={(mode) =>
                  setValues((current) => ({ ...current, listed: mode === "LISTED" }))
                }
              />

              {/* SIMPLE/PACK. Beside `listing` rather than in its own panel: it
                  is the same kind of one-off, rarely-revisited choice, made once
                  near the top of the form before the operator gets to pricing
                  and components. */}
              <PopupButton
                label={t("kindLabel")}
                name="kind"
                value={values.kind}
                hint={t("kindHint")}
                options={PRODUCT_KINDS.map((kind) => ({
                  value: kind,
                  label: t(`kindOptions.${kind}`),
                }))}
                onChange={(kind) => setValues((current) => ({ ...current, kind }))}
              />

            </div>
          </Panel>

          {mediaSlot !== undefined && (
            <Panel title={t("imagesTitle")} disabled={submitting}>
              {mediaSlot}
            </Panel>
          )}
        </aside>
      </div>

      {/* The id is referenced by the form's `aria-describedby`, so it sits on a
          wrapper: `Notice` owns its own `role="alert"` and takes no id. */}
      <div id={`${formId}-error`} className="mt-4 empty:hidden">
        {shownError === undefined ? null : (
          <Notice tone="danger" placement="inline">
            {shownError}
          </Notice>
        )}
      </div>

      {/* STICKY, AND GLASS. Even at this density an edit page with six variants
          scrolls past the save button, and an operator who cannot see it assumes
          their work is unsaved. The negative gutter margins let the bar span the
          page's full width while the form keeps its own measure.

          ONE BUTTON, not the three the artboard draws. "Guardar y publicar" would
          fold two operations the API keeps apart — publishing has its own rules
          and its own error naming the missing variant or translation, and it
          lives on `ProductEditor` beside Unpublish. "Descartar" is the browser's
          back button plus an unsaved-changes prompt, which is a guard this form
          does not yet install; shipping the button without the guard would make
          it a one-click way to lose the work the dot beside it is warning about. */}
      <div className="sticky bottom-0 z-10 -mx-[var(--gutter)] mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--separator-weak)] bg-[var(--glass-fill-strong)] px-[var(--gutter)] py-2.5 backdrop-blur-[24px]">
        {dirty && (
          <span className="flex items-center gap-1.5 text-[12px] text-[var(--label-secondary)]">
            {/* The dot is decorative; the sentence beside it is what carries the
                state, so nothing is said in colour alone. */}
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full bg-[var(--warning)]"
            />
            {t("unsavedChanges")}
          </span>
        )}
        {helperText === "" ? null : (
          <span className="text-[12px] text-[var(--label-secondary)]">{helperText}</span>
        )}
        <div className="ms-auto flex items-center gap-2">
        <IconButton
          label={t("previewProduct")}
          icon="eye"
          variant="standard"
          size="compact"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={previewOpen}
          // The bar sits OUTSIDE every fieldset, so the Panel freeze does not
          // reach it and the disable has to be said explicitly.
          disabled={submitting}
          onClick={() => setPreviewOpen(true)}
        />
        <Button
          type="submit"
          variant="prominent"
          size="compact"
          pending={submitting}
          // The kit's shared "Guardando…", not a product-form copy of it: the
          // in-flight label is the same sentence on every form in the product.
          pendingLabel={tUi("saving")}
          disabled={submitting}
        >
          {submitLabel}
        </Button>
        </div>
      </div>

      <ProductPreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        locale={activeLocale}
        currency={values.currency}
        name={activeCopy.name}
        shortDescription={activeCopy.shortDescription}
        description={activeCopy.description}
        images={previewImageList}
        variants={previewVariants}
        addOns={previewAddOns}
      />
    </form>
  );
}

// ---------------------------------------------------------------------------
// The locale switch
// ---------------------------------------------------------------------------

/** What one segment says about its locale, beyond its name. */
interface LocaleStatus {
  /** How many of the three copy fields are still blank. */
  readonly empty: number;
  /** This locale's copy came from a machine and nobody has read it since. */
  readonly machine: boolean;
  /** The whole sentence — announced, and the source of the visible chip. */
  readonly text: string;
}

interface LocaleSwitchProps {
  /** The group's accessible name, already translated. */
  readonly label: string;
  /** Radio group name. Must be unique per form instance. */
  readonly name: string;
  readonly value: Locale;
  readonly onChange: (locale: Locale) => void;
  readonly status: (locale: Locale) => LocaleStatus;
}

/**
 * The segmented control that swaps which language the copy panel is editing.
 *
 * WHY IT IS NOT `ui/segmented-control`. That component is a row of `<Link>`s:
 * every segment is a URL, chosen by navigating, and the choice is read back off
 * `searchParams`. It is exactly right for a filter over a server-rendered list
 * and exactly wrong here — following one would remount this form and discard
 * every unsaved keystroke in it. The paint is deliberately the same (same track
 * fill, same concentric radii, same selected pill) so the two read as one
 * control; only the mechanism differs.
 *
 * NATIVE RADIOS UNDER THE PAINT, following `ui/toggle`. A real radio group
 * brings arrow-key movement, a single tab stop, and — the reason it matters
 * here — it is a form control, so the enclosing `<fieldset disabled>` freezes
 * the language switch along with everything else while a save is in flight. A
 * row of `<button>`s would need all three re-implemented.
 *
 * THE COMPLETENESS INDICATOR IS THE POINT, not decoration. It is what survived
 * from the two-card layout: an operator has to be able to see that English is
 * empty without switching to it. The count is drawn as a chip and stated in
 * full for a screen reader, so nothing is said in colour alone.
 */
function LocaleSwitch({ label, name, value, onChange, status }: LocaleSwitchProps) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex gap-[2px] rounded-[calc(var(--r-control)+2px)] bg-[var(--fill-tertiary)] p-[2px]"
    >
      {LOCALE_ORDER.map((locale) => {
        const selected = locale === value;
        const state = status(locale);

        return (
          <label
            key={locale}
            className={`inline-flex min-h-[var(--control-h)] cursor-pointer items-center gap-1.5 rounded-[var(--r-control)] px-2.5 text-[13px] font-medium transition-colors motion-reduce:transition-none has-[:focus-visible]:shadow-[0_0_0_4px_var(--focus-ring)] ${
              selected
                ? "bg-[var(--bg-grouped-secondary)] text-[var(--label)] shadow-[var(--e-0)]"
                : "text-[var(--label-secondary)] hover:text-[var(--label)]"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={locale}
              checked={selected}
              onChange={() => {
                onChange(locale);
              }}
              className="sr-only"
            />
            <span>{LANGUAGE_NAME[locale]}</span>
            {state.empty > 0 ? (
              <span
                aria-hidden="true"
                className="inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-[var(--r-pill)] bg-[var(--danger-fill)] px-1 text-[10px] font-semibold text-[var(--danger-text)] tabular-nums"
              >
                {state.empty}
              </span>
            ) : state.machine ? (
              // Complete, but not by a human. A check mark here would say the
              // language is done, which is the one thing it is not.
              <Icon name="triangle-alert" size={12} className="text-[var(--warning)]" />
            ) : (
              // `Icon` marks itself `aria-hidden` unless it is given a title,
              // which is exactly right here: the sr-only sentence below already
              // says "complete".
              <Icon name="check" size={12} className="text-[var(--success-text)]" />
            )}
            {/* The full sentence, for the accessible name. The chip beside it is
                the same fact drawn small, so the two can never disagree. */}
            <span className="sr-only">{state.text}</span>
          </label>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small helpers used by the component
// ---------------------------------------------------------------------------

/**
 * Spread onto a control only when there IS an error.
 *
 * `exactOptionalPropertyTypes` makes `error={undefined}` a type error rather
 * than a no-op, and the alternative — `error={x ?? ""}` — renders an empty
 * error region and sets `aria-invalid` on a field nobody has touched.
 */
function optionalError(message: string | undefined): { readonly error?: string } {
  return message === undefined ? {} : { error: message };
}

/** How much of one locale's copy is still blank. Drives the segment's chip. */
function emptyFieldCount(translation: TranslationDraft): number {
  return [translation.name, translation.shortDescription, translation.description].filter(
    (value) => value.trim() === "",
  ).length;
}

function isBlankCopy(translation: TranslationDraft): boolean {
  return emptyFieldCount(translation) === 3;
}

/** With two locales, "the other one" is a function rather than a lookup. */
function otherLocale(locale: Locale): Locale {
  return locale === "es" ? "en" : "es";
}

/**
 * One locale's draft, always.
 *
 * `toFormValues` seeds every locale in `LOCALE_ORDER`, so the fallback is
 * unreachable — but `find` is `T | undefined` under `noUncheckedIndexedAccess`
 * and a `!` to dodge that is banned repo-wide. An empty draft renders empty
 * fields, which is the correct behaviour for a locale that somehow has no row,
 * where a crash is not.
 */
function translationFor(values: ProductFormValues, locale: Locale): TranslationDraft {
  return (
    values.translations.find((translation) => translation.locale === locale) ?? {
      locale,
      name: "",
      shortDescription: "",
      description: "",
    }
  );
}

/** Whether any of this locale's copy fields was rejected. */
function hasCopyError(errors: FieldErrors, locale: Locale): boolean {
  return Object.keys(errors).some((path) => path.startsWith(`translations.${locale}.`));
}

/**
 * Whether the form still holds exactly what it opened with.
 *
 * Structural rather than field-by-field: every value in `ProductFormValues` is a
 * string, a boolean or an array of those, both sides are built by the same two
 * code paths (`toFormValues` and `emptyVariant`), so key order is stable and
 * `JSON.stringify` is a sound equality here. It is also the only comparison that
 * does not need updating when a field is added — which is exactly the kind of
 * omission that makes an unsaved-changes indicator lie.
 */
function sameValues(a: ProductFormValues, b: ProductFormValues): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface PanelProps {
  readonly title: string;
  readonly description?: string;
  /**
   * Controls that belong to the panel rather than to a field in it — the locale
   * switch and the translate button.
   *
   * Rendered as a SIBLING of the legend, not inside it: a `<legend>` takes
   * phrasing content, and a radio group is not phrasing content. From `sm` up
   * it is absolutely positioned into the legend's own line, which is what keeps
   * the header one row tall instead of two.
   */
  readonly actions?: ReactNode;
  readonly disabled: boolean;
  readonly children: ReactNode;
}

/**
 * One card in the form — and a `<fieldset>`, never a `<div>`.
 *
 * See rule 3 in the file header for why. `ui/card`'s `Card` draws the same
 * surface and cannot be used here: it renders a `<section>`, which has no
 * `disabled` and no group name, so composing it would trade the freeze for a
 * shared import.
 */
function Panel({ title, description, actions, disabled, children }: PanelProps) {
  return (
    <fieldset
      disabled={disabled}
      className="relative m-0 min-w-0 rounded-[var(--r-card)] border-0 bg-[var(--bg-grouped-secondary)] p-[var(--card-p)] shadow-[var(--e-0)] disabled:opacity-60"
    >
      {/* FLOATED on purpose: an unfloated <legend> is drawn ON the fieldset's
          top edge, so the title sat across the card border. */}
      <legend className="float-left inline-flex w-full min-h-[var(--control-h)] items-center p-0 text-[15px] leading-5 font-semibold tracking-[-0.23px] text-[var(--label)]">
        {title}
      </legend>
      <div className="clear-both" />
      {actions === undefined ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2 sm:absolute sm:top-[var(--card-p)] sm:right-[var(--card-p)] sm:mt-0">
          {actions}
        </div>
      )}
      {description !== undefined && (
        <p className="mt-0.5 mb-2 text-[11px] leading-4 text-[var(--label-secondary)]">
          {description}
        </p>
      )}
      <div className={description === undefined ? "mt-2" : undefined}>{children}</div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for direct testing.
// ---------------------------------------------------------------------------

export type BuildResult =
  | { readonly ok: true; readonly value: CreateProduct }
  | { readonly ok: false; readonly errors: FieldErrors };

/** One staged file, addressed to the variant the operator put it on. */
export interface StagedVariantImage {
  /**
   * The SKU as SUBMITTED — the key the created variants are matched back by.
   *
   * Trimmed here exactly as `buildPayload` trims it, so the two agree byte for
   * byte and the lookup on the other side cannot miss by a stray space.
   */
  readonly sku: string;
  readonly image: StagedImage;
}

/**
 * The files staged against variants, tagged with the SKU each belongs to.
 *
 * TAGGED BY SKU, NOT BY POSITION, and that is the whole reason this function
 * exists rather than the caller zipping two arrays. The caller has to place each
 * file on a variant the API has just created, and the API is under no obligation
 * to return the variants in the order they were sent: an index match silently
 * attaches the black photo to the white variant, and nothing fails.
 */
export function stagedVariantImages(
  values: ProductFormValues,
): readonly StagedVariantImage[] {
  return values.variants.flatMap((variant) =>
    variant.stagedImage === null
      ? []
      : [{ sku: variant.sku.trim(), image: variant.stagedImage }],
  );
}

/**
 * Turn form strings into a validated `CreateProduct`.
 *
 * Money is converted FIRST, through `parseMajorUnitInput`, because a price the
 * admin typed as "49,99,5" must produce a message about the price field rather
 * than a NaN that the schema then reports as "expected number, received nan"
 * against a path the operator cannot map back to a box on the screen.
 *
 * Everything else is left to `createProductSchema.safeParse` — the SAME schema
 * the API uses. Re-implementing "slug must be kebab-case" here would be a second
 * copy of a rule that already exists.
 *
 * THE ONE PLACE ENGLISH STILL REACHES AN OPERATOR is a zod issue's own
 * `issue.message` ("String must contain at most 200 character(s)"), and it is
 * the deliberate remaining debt: those messages belong to the contract, the
 * catalogue authors no keys for them, and inventing a per-issue message table
 * here would be a third copy of rules that already live in the schema. Every
 * message this file DECIDES on is translated and arrives through `messages`.
 */
/**
 * The discount a tier represents, as a whole percent of the variant's own price.
 *
 * DERIVED, NEVER STORED. `priceTiers` holds an absolute unit price because that
 * is the figure the cart charges — storing a percentage would move the rounding
 * to charge time and let the page and the checkout disagree by a cent. So the
 * percentage is recomputed from the two prices on every render.
 *
 * Empty when either price is unparseable or the base is zero: a percentage of
 * nothing is not 0 %, it is not a question.
 */
export function tierPercent(
  variant: VariantDraft,
  tier: TierDraft,
  currency: CurrencyCode,
): string {
  const base = parseMajorUnitInput(variant.priceGross, currency);
  const tierPrice = parseMajorUnitInput(tier.unitPriceGross, currency);

  if (!base.ok || !tierPrice.ok || base.value <= 0) return "";

  return String(Math.round((1 - tierPrice.value / base.value) * 100));
}

/**
 * The unit price a typed percentage means, formatted for the money input.
 *
 * `null` when it cannot be computed — an unparseable base price, or a figure
 * outside 1-99 — and the caller then leaves the price alone rather than writing
 * a nonsense one. 100 % is excluded deliberately: a free tier is a price of
 * zero, which the operator can type directly and see, rather than something a
 * discount field produces by accident.
 */
export function tierPriceFromPercent(
  variant: VariantDraft,
  percent: string,
  currency: CurrencyCode,
): string | null {
  const base = parseMajorUnitInput(variant.priceGross, currency);
  const typed = percent.trim();

  if (!base.ok || !/^\d{1,2}$/.test(typed)) return null;

  const value = Number(typed);
  if (value < 1 || value > 99) return null;

  return formatMinorAsInput(toMinor(Math.round(base.value * (1 - value / 100))), currency);
}

/**
 * The stack-discount schedule, previewed against a variant's CURRENTLY TYPED
 * price — the same `computeStackDiscountTiers` call the API makes when it
 * persists this variant, so the preview shown here and the schedule actually
 * charged cannot drift apart. Empty while the price has not parsed yet, e.g.
 * a brand-new variant with a blank price field.
 */
export function stackDiscountPreview(
  variant: VariantDraft,
  currency: CurrencyCode,
): readonly PriceTier[] {
  const base = parseMajorUnitInput(variant.priceGross, currency);
  return base.ok ? computeStackDiscountTiers(base.value) : [];
}

export function buildPayload(
  values: ProductFormValues,
  messages: ProductFormMessages,
): BuildResult {
  const errors: Record<string, string> = {};

  const variants = values.variants.map((variant, index) => {
    const price = parseMajorUnitInput(variant.priceGross, values.currency);
    if (!price.ok) {
      errors[`variants.${index}.priceGross`] = messages.money[price.error];
    }

    // An empty compare-at is legitimately "no sale price", not an error.
    const compareAtRaw = variant.compareAtGross.trim();
    let compareAt: number | null = null;
    if (compareAtRaw.length > 0) {
      const parsed = parseMajorUnitInput(compareAtRaw, values.currency);
      if (parsed.ok) {
        compareAt = parsed.value;
      } else {
        errors[`variants.${index}.compareAtGross`] = messages.money[parsed.error];
      }
    }

    if (price.ok && compareAt !== null && compareAt < price.value) {
      // A compare-at below the selling price renders as a negative discount and
      // is an unlawful price display in several EU jurisdictions. The API
      // rejects it too; catching it here names the field.
      errors[`variants.${index}.compareAtGross`] = messages.compareAtTooLow;
    }

    const weight = parseOptionalInteger(variant.weightGrams);
    if (weight === "invalid") {
      errors[`variants.${index}.weightGrams`] = messages.notWholeGrams;
    }

    const stock = parseOptionalInteger(variant.initialStock);
    if (stock === "invalid") {
      errors[`variants.${index}.initialStock`] = messages.notAWholeNumber;
    }

    const threshold = parseOptionalInteger(variant.lowStockThreshold);
    if (threshold === "invalid") {
      errors[`variants.${index}.lowStockThreshold`] = messages.notAWholeNumber;
    }

    const size = variantSize(variant);
    const colorTyped = variant.color.trim().length > 0;

    if (size === null && (colorTyped || values.variants.length > 1)) {
      // ONLY WHEN THERE IS MORE THAN ONE. A single variant needs no label — the
      // storefront shows no picker for it and falls back to the product name —
      // so demanding a size from a plain product would be the form inventing a
      // requirement the shop does not have.
      // A colour with no size is also refused: the size is the option every
      // variant is keyed on, and a colour alone would name half an option set.
      errors[`variants.${index}.size`] = messages.sizeRequired;
    }

    if (size !== null) {
      // Two variants of one product may not share a size. This is the operator's
      // own words for a constraint the DATABASE enforces as
      // `product_variant_options_unique`, which would otherwise surface as an
      // unexplained CONFLICT after the save round-trips.
      const token = sizeToken(size);
      const first = values.variants.findIndex((other) => {
        const otherSize = variantSize(other);
        return otherSize !== null && sizeToken(otherSize) === token;
      });
      if (first !== index) {
        errors[`variants.${index}.size`] = messages.sizeDuplicate;
      }
    }

    // VOLUME TIERS. Every rule here is one the database or the contract also
    // enforces, named in the operator's language so it surfaces beside the field
    // instead of as an opaque 400 after the save round-trips:
    //   - `minQuantity >= 2` is a CHECK constraint; a tier at 1 is the base price.
    //   - `(variantId, minQuantity)` is UNIQUE; two rows at 5 is a lost write.
    //   - a tier at or above the unit price is not a discount, and displaying it
    //     as "−0 %" beside a volume table is a false saving claim.
    const priceTiers: { minQuantity: number; unitPriceGross: number }[] = [];

    if (values.kind === "PACK") {
      // NEVER SUBMITTED FOR A PACK, whatever this row's own `priceTiers`
      // state still holds from before the operator switched to PACK — the
      // panel that edits it is hidden the same way, and the two must agree.
    } else if (values.stackDiscountEnabled) {
      // FIXED AND COMPUTED: none of the freeform rules above apply, because a
      // schedule this function derives itself cannot violate them. `!price.ok`
      // leaves this empty, but that payload is never sent — the money error
      // recorded above already short-circuits the whole submit.
      if (price.ok) {
        priceTiers.push(...computeStackDiscountTiers(price.value));
      }
    } else {
      const seenQuantities = new Set<number>();

      variant.priceTiers.forEach((tier, tierIndex) => {
        const field = `variants.${index}.priceTiers.${tierIndex}`;
        const quantityRaw = tier.minQuantity.trim();

        // Digits only: `Number(" 5 ")` is 5 and `Number("5e3")` is 5000, neither
        // of which is what an operator typed into a quantity box.
        if (!/^\d+$/.test(quantityRaw) || Number(quantityRaw) < 2) {
          errors[`${field}.minQuantity`] = messages.tierQuantityInvalid;
          return;
        }

        const quantity = Number(quantityRaw);
        if (seenQuantities.has(quantity)) {
          errors[`${field}.minQuantity`] = messages.tierDuplicate;
          return;
        }
        seenQuantities.add(quantity);

        const tierPrice = parseMajorUnitInput(tier.unitPriceGross, values.currency);
        if (!tierPrice.ok) {
          errors[`${field}.unitPriceGross`] = messages.money[tierPrice.error];
          return;
        }

        if (price.ok && tierPrice.value >= price.value) {
          errors[`${field}.unitPriceGross`] = messages.tierPriceTooHigh;
          return;
        }

        priceTiers.push({ minQuantity: quantity, unitPriceGross: tierPrice.value });
      });

      // Sorted on the way out. `resolveUnitPrice` is explicitly order-independent,
      // so this is for the humans reading the row and the API's own ordering —
      // never something the resolver is allowed to depend on.
      priceTiers.sort((a, b) => a.minQuantity - b.minQuantity);
    }

    return {
      sku: variant.sku.trim(),
      name: buildVariantName(variant),
      // THE OPTION SET, AND IT MUST NOT BE EMPTY FOR A SECOND VARIANT.
      // `20260720000100/migration.sql:113` puts a UNIQUE index on
      // ("productId", "options") for live rows, so two variants both sending {}
      // collide and the second insert fails as an opaque CONFLICT. This form
      // sent {} unconditionally, which is why a two-variant product could not be
      // created here at all. Size (and colour) is what makes the rows distinct —
      // the same shape the seed stores, e.g. {"size": "M", "color": "Black"}.
      options: variantOptions(size),
      priceGross: price.ok ? price.value : 0,
      compareAtGross: compareAt,
      currency: values.currency,
      weightGrams: weight === "invalid" ? null : weight,
      initialStock: stock === "invalid" || stock === null ? 0 : stock,
      lowStockThreshold: threshold === "invalid" || threshold === null ? 5 : threshold,
      allowBackorder: variant.allowBackorder,
      priceTiers,
    };
  });

  // Money problems short-circuit: reporting schema errors on a price we already
  // know is unparseable would show the operator two messages for one mistake.
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const parsed = createProductSchema.safeParse({
    slug: values.slug.trim(),
    status: values.status,
    taxClass: values.taxClass,
    listed: values.listed,
    offerOnNewProducts: values.offerOnNewProducts,
    // Update-only: while creating, the variants have no ids for it to name.
    newProductDefaultVariantId: values.newProductDefaultVariantId,
    stackDiscountEnabled: values.stackDiscountEnabled,
    kind: values.kind,
    // OMITTED ENTIRELY for a SIMPLE product, not sent as `[]`: the schema's
    // own `.min(3)` rejects an explicit empty array just as it would reject
    // one or two entries, so `undefined` — "not touching this" — is the only
    // legal way to say "no components" here. The server clears a product's
    // stored components on its own the moment `kind` turns away from PACK
    // (`assertValidPackComponentInput`/`update()`'s own comment), so this
    // never has to ask for that explicitly.
    ...(values.kind === "PACK" ? { packComponents: values.packComponents } : {}),
    addOns: values.addOns,
    translations: values.translations
      .filter((translation) => translation.name.trim().length > 0)
      .map((translation) => ({
        locale: translation.locale,
        name: translation.name.trim(),
        shortDescription: translation.shortDescription.trim(),
        // SANITISED ON THE WAY OUT, with the same function the preview drew
        // with and the API applies on write. Not because this client is
        // trusted to be the last word — it is not, and the API sanitising
        // again is what actually enforces the policy — but because a form
        // that previews one string and posts another has a sanitiser in name
        // only. `sanitizeRichText` is idempotent, so the API's own call over
        // this value changes nothing and what the operator saw is what is
        // stored, byte for byte.
        //
        // `shortDescription` is deliberately NOT put through it: the summary
        // renders as plain text, so escaping would turn an operator's
        // "10 < 20" into a visible "10 &lt; 20". Escaping is right for one for
        // exactly the reason it is wrong for the other.
        description: sanitizeRichText(translation.description.trim()),
      })),
    variants,
    categoryIds: values.categoryIds,
    restrictedCountries: [],
  });

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = mapIssuePath(issue.path, values);
      // First error per field wins: a stack of messages under one input is
      // noise, and zod reports the most specific failure first.
      errors[path] ??= issue.message;
    }
    return { ok: false, errors };
  }

  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Classifying variant rows on an EDIT — new vs. changed vs. untouched
// ---------------------------------------------------------------------------

export interface VariantUpdate {
  readonly variantId: string;
  /** As currently typed, for naming this row in a failure message — never sent. */
  readonly sku: string;
  readonly patch: UpdateVariantRequest;
}

export interface InventoryPolicyUpdate {
  readonly variantId: string;
  /** As currently typed, for naming this row in a failure message — never sent. */
  readonly sku: string;
  readonly policy: SetInventoryPolicyRequest;
}

export interface ClassifiedVariantChanges {
  /** Rows with no server-side match — created via `addVariant`, in row order. */
  readonly newVariants: readonly CreateVariant[];
  /** Rows whose PATCH-able fields differ from what is stored. */
  readonly updatedVariants: readonly VariantUpdate[];
  /** Rows whose reorder threshold or backorder policy differs from what is stored. */
  readonly inventoryPolicyChanges: readonly InventoryPolicyUpdate[];
}

function sameName(
  a: Partial<Record<Locale, string>> | null,
  b: Partial<Record<Locale, string>> | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.es === b.es && a.en === b.en;
}

function sameOptions(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

function sameTiers(
  a: readonly { minQuantity: number; unitPriceGross: number }[],
  b: readonly { minQuantity: number; unitPriceGross: number }[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((tier, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      tier.minQuantity === other.minQuantity &&
      tier.unitPriceGross === other.unitPriceGross
    );
  });
}

/**
 * Sorts every variant row on an EDIT into what actually needs to happen to it.
 *
 * WHY THIS EXISTS AT ALL. `buildPayload` produces the CREATE shape — one flat
 * `variants` array, with no id and no notion of "this one already exists".
 * That is correct for creating a product, and is exactly why saving an EDIT
 * used to delete `variants` from the payload wholesale rather than send it
 * somewhere wrong: a row that already exists cannot be re-created, and this
 * function is what tells the two cases apart before either one is attempted.
 *
 * `builtVariants` is `buildPayload`'s own already-validated `value.variants` —
 * positionally aligned with `values.variants`, since neither function filters
 * or reorders. Re-deriving the same parse here instead would be a second copy
 * of `buildPayload`'s price/size/tier parsing that could drift from the first.
 *
 * A ROW'S KEY IS ITS SERVER ID WHEN IT HAS ONE. `toFormValues` seeds an
 * existing row's `key` from `variant.id`; a row added on this page via
 * "Añadir variante" gets a `new-N` key that matches nothing stored — that
 * absence, not a flag, is what marks it new.
 *
 * ONLY FIELDS THAT ACTUALLY CHANGED are sent, not the whole row: `undefined`
 * on `UpdateVariantRequest` means "leave this alone", matching the API's own
 * contract for it — sending every field on every save would turn a one-field
 * edit into "resave everything", which is harmless today but is the kind of
 * assumption a future field (one where absence and "set to the empty value"
 * differ) would get wrong silently.
 *
 * `initialStock` NEVER APPEARS IN A PATCH HERE, even though `buildPayload`
 * computes it: the form disables that input for an existing row (see
 * `variantImageCell`'s neighbour, the stock field), on-hand is a ledger balance
 * changed by a signed delta and a mandatory reason
 * (`adjustInventoryRequestSchema`), not a "type a new number" field — the
 * page's own "Ajustar stock" control is that surface, deliberately left alone.
 */
export function classifyVariantChanges(
  values: ProductFormValues,
  product: Product | undefined,
  builtVariants: readonly CreateVariant[],
): ClassifiedVariantChanges {
  const stored = new Map(
    (product?.variants ?? []).map((variant) => [variant.id, variant] as const),
  );

  const newVariants: CreateVariant[] = [];
  const updatedVariants: VariantUpdate[] = [];
  const inventoryPolicyChanges: InventoryPolicyUpdate[] = [];

  values.variants.forEach((draft, index) => {
    const built = builtVariants[index];
    // Unreachable in practice — both arrays come from the same `.map()` over
    // `values.variants` — but an index lookup off external-shaped data should
    // not silently read `undefined` deeper in.
    if (built === undefined) {
      return;
    }

    const existing = stored.get(draft.key);
    if (existing === undefined) {
      newVariants.push(built);
      return;
    }

    const patch: UpdateVariantRequest = {
      version: draft.version,
      ...(built.sku === existing.sku ? {} : { sku: built.sku }),
      ...(sameName(built.name, existing.name) && sameOptions(built.options, existing.options)
        ? {}
        : { name: built.name, options: built.options }),
      ...(built.priceGross === existing.price.gross ? {} : { priceGross: built.priceGross }),
      ...(built.compareAtGross === existing.price.compareAtGross
        ? {}
        : { compareAtGross: built.compareAtGross }),
      ...(built.weightGrams === existing.weightGrams ? {} : { weightGrams: built.weightGrams }),
      ...(sameTiers(built.priceTiers, existing.priceTiers)
        ? {}
        : { priceTiers: built.priceTiers }),
    };

    // More than just `version`, which is always present as the concurrency
    // token but names nothing that changed on its own.
    if (Object.keys(patch).length > 1) {
      updatedVariants.push({ variantId: existing.id, sku: existing.sku, patch });
    }

    if (
      built.lowStockThreshold !== existing.inventory.lowStockThreshold ||
      built.allowBackorder !== existing.inventory.allowBackorder
    ) {
      inventoryPolicyChanges.push({
        variantId: existing.id,
        sku: existing.sku,
        policy: {
          lowStockThreshold: built.lowStockThreshold,
          allowBackorder: built.allowBackorder,
        },
      });
    }
  });

  return { newVariants, updatedVariants, inventoryPolicyChanges };
}

/**
 * Map a zod issue path onto the form's field ids.
 *
 * `translations.0.name` is meaningless to the operator, who sees a box under a
 * "Español" heading. Rewriting the index to a locale is what lets the message
 * land under the right field — and, now that one locale is on screen at a time,
 * what lets `handleSubmit` work out which language to switch to.
 */
function mapIssuePath(
  path: readonly (string | number)[],
  values: ProductFormValues,
): string {
  const [head, index, ...rest] = path;

  if (head === "translations" && typeof index === "number") {
    const locale = values.translations[index]?.locale ?? index;
    return ["translations", locale, ...rest].join(".");
  }

  return path.join(".");
}

/** `null` = empty (legitimate), `"invalid"` = not a whole number. */
function parseOptionalInteger(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    return "invalid";
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

interface VariantSize {
  readonly size: string;
  /** Empty when the variant has no colour. */
  readonly color: string;
}

/**
 * The label a shopper reads: "M", or "M / Black" when a colour is set. The
 * same in both locales — sizes and the operator's colour names are not
 * translated here.
 */
function sizeLabel(size: VariantSize): string {
  return size.color === "" ? size.size : `${size.size} / ${size.color}`;
}

/**
 * The comparison key for "two variants share an option set". Case-insensitive,
 * so "m / black" and "M / Black" are caught before the database's own
 * `product_variant_options_unique` turns them into an opaque CONFLICT.
 */
function sizeToken(size: VariantSize): string {
  return `${size.size.toLowerCase()}\u0000${size.color.toLowerCase()}`;
}

/** The variant's `options`: `{ size }`, `{ size, color }`, or `{}` with no size. */
function variantOptions(size: VariantSize | null): Record<string, string> {
  if (size === null) {
    return {};
  }
  return size.color === "" ? { size: size.size } : { size: size.size, color: size.color };
}

/** The size fields, when a size is typed. Null when the variant has no size. */
function variantSize(variant: VariantDraft): VariantSize | null {
  const size = variant.size.trim();
  return size.length === 0 ? null : { size, color: variant.color.trim() };
}

/**
 * Should the size fields be on screen from the start?
 *
 * A product that already sells in sizes, or that has more than one variant, is
 * one an operator opened this form to edit — so it opens expanded. A new plain
 * product opens collapsed and asks for a price, not a taxonomy.
 */
function shouldOpenVariants(values: ProductFormValues): boolean {
  const [first] = values.variants;
  return (
    values.variants.length > 1 || (first !== undefined && variantSize(first) !== null)
  );
}

function buildVariantName(
  variant: VariantDraft,
): Partial<Record<Locale, string>> | null {
  const size = variantSize(variant);
  if (size !== null) {
    // A size OVERRIDES the carried name, because the operator just typed it and
    // the carried value is whatever was stored before they did.
    const label = sizeLabel(size);
    return { es: label, en: label };
  }
  const name: Partial<Record<Locale, string>> = {};
  if (variant.nameEs.trim().length > 0) {
    name.es = variant.nameEs.trim();
  }
  if (variant.nameEn.trim().length > 0) {
    name.en = variant.nameEn.trim();
  }
  // Null rather than {} for a single-variant product: the contract models "this
  // product has no variant-level name" as null, and an empty object would render
  // as a blank label rather than falling back to the product name.
  return Object.keys(name).length === 0 ? null : name;
}

/** Seed the form from an existing product, or from blank defaults. */
export function toFormValues(
  product: Product | undefined,
  currency: CurrencyCode,
  initialKind?: "SIMPLE" | "PACK",
): ProductFormValues {
  if (product === undefined) {
    return {
      slug: "",
      status: "DRAFT",
      taxClass: "STANDARD",
      // A new product is LISTED unless somebody says otherwise, matching both
      // the contract's default and the column's — an add-on is the deliberate
      // choice, never the one made by forgetting.
      listed: true,
      currency,
      kind: initialKind ?? "SIMPLE",
      packComponents: [],
      addOns: [],
      categoryIds: [],
      offerOnNewProducts: false,
      newProductDefaultVariantId: null,
      stackDiscountEnabled: false,
      translations: LOCALE_ORDER.map((locale) => ({
        locale,
        name: "",
        shortDescription: "",
        description: "",
      })),
      variants: [emptyVariant()],
    };
  }

  return {
    slug: product.slug,
    status: product.status,
    taxClass: product.taxClass,
    listed: product.listed,
    offerOnNewProducts: product.offerOnNewProducts,
    newProductDefaultVariantId: product.newProductDefaultVariantId,
    stackDiscountEnabled: product.stackDiscountEnabled,
    currency,
    // An EXISTING row's own kind always wins over `initialKind` — that hint is
    // only ever meaningful before the first save.
    kind: product.kind,
    // Already ordered by the edge's `sortOrder`, same as `addOns` below.
    packComponents: product.packComponents.map((ref) => ({
      id: ref.id,
      variantId: ref.variantId,
      quantity: ref.quantity,
    })),
    // Already ordered by the edge's `sortOrder`, so the operator's arrangement
    // survives a round trip through the form untouched.
    addOns: product.addOns.map((ref) => ({
      id: ref.id,
      defaultVariantId: ref.defaultVariantId,
    })),
    categoryIds: product.categories.map((category) => category.id),
    translations: LOCALE_ORDER.map((locale) => {
      const existing = product.translations.find(
        (translation) => translation.locale === locale,
      );
      return {
        locale,
        name: existing?.name ?? "",
        shortDescription: existing?.shortDescription ?? "",
        description: existing?.description ?? "",
      };
    }),
    variants: product.variants.map((variant) => ({
      key: variant.id,
      version: variant.version,
      sku: variant.sku,
      nameEs: variant.name?.es ?? "",
      nameEn: variant.name?.en ?? "",
      // Read size and colour back from the variant's OPTIONS, the structured
      // source the name was built from. A variant with no `size` option (a name
      // like "Pack de inicio") leaves these blank and its name keeps being
      // carried by `buildVariantName`, so an untouched save cannot erase it.
      size: variant.options["size"] ?? "",
      color: variant.options["size"] === undefined ? "" : (variant.options["color"] ?? ""),
      // Round-trips exactly: formatMinorAsInput is the inverse of
      // parseMajorUnitInput, pinned by a property test in money-input.test.ts.
      // Saving an untouched form must not change the price by a cent.
      priceGross: formatMinorAsInput(variant.price.gross, variant.price.currency),
      compareAtGross:
        variant.price.compareAtGross === null
          ? ""
          : formatMinorAsInput(variant.price.compareAtGross, variant.price.currency),
      weightGrams: variant.weightGrams === null ? "" : String(variant.weightGrams),
      initialStock: String(variant.inventory.onHand),
      lowStockThreshold: String(variant.inventory.lowStockThreshold),
      allowBackorder: variant.inventory.allowBackorder,
      // Never seeded from `variant.image`: an existing variant's picture is read
      // from the `product` prop at render time so a live upload shows up without
      // a remount. This field is only ever a file waiting for a product to exist.
      stagedImage: null,
      // Read back in the order the API returned, which is ascending by
      // quantity. `formatMinorAsInput` is the inverse of `parseMajorUnitInput`,
      // so saving an untouched form cannot move a tier price by a cent.
      priceTiers: variant.priceTiers.map((tier, tierIndex) => ({
        key: `${variant.id}-tier-${tierIndex}`,
        minQuantity: String(tier.minQuantity),
        unitPriceGross: formatMinorAsInput(tier.unitPriceGross, variant.price.currency),
      })),
    })),
  };
}

let variantCounter = 0;

function emptyVariant(): VariantDraft {
  variantCounter += 1;
  return {
    key: `new-${variantCounter}`,
    // Never read: `classifyVariantChanges` routes a row with no stored match
    // to `addVariant`, which has no version to send.
    version: 0,
    sku: "",
    nameEs: "",
    nameEn: "",
    size: "",
    color: "",
    priceGross: "",
    compareAtGross: "",
    weightGrams: "",
    initialStock: "0",
    lowStockThreshold: "5",
    allowBackorder: false,
    stagedImage: null,
    priceTiers: [],
  };
}

let tierCounter = 0;

function emptyTier(): TierDraft {
  tierCounter += 1;
  return { key: `tier-${tierCounter}`, minQuantity: "", unitPriceGross: "" };
}
