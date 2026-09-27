"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  authFailureReasonSchema,
  type Category,
  type CreateProduct,
  type CurrencyCode,
  type Product,
} from "@akai/contracts";

import { useRouter } from "@/i18n/navigation";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import type { StagedImage } from "@/components/ui/media-uploader";
import type { AddOnCandidate } from "./add-on-picker";
import type { PackComponentCandidate } from "./pack-components-picker";
import {
  addProductMediaAction,
  addVariantAction,
  createMediaUploadUrlAction,
  createProductAction,
  deleteProductAction,
  offerProductEverywhereAction,
  publishProductAction,
  removeProductMediaAction,
  setVariantInventoryPolicyAction,
  unpublishProductAction,
  translateProductCopyAction,
  updateProductAction,
  updateVariantAction,
  type ActionErrorCode,
  type ActionResult,
} from "@/lib/admin/actions";
import {
  translateCopyReasonOf,
  type TranslateCopyReason,
} from "@/lib/admin/translate-copy";
import { uploadProductImage } from "@/lib/admin/upload-product-image";

import { ConfirmActionError } from "./type-to-confirm-button";
import { DeleteProductButton } from "./delete-product-button";
import {
  ProductForm,
  TranslateCopyError,
  type ClassifiedVariantChanges,
  type OfferEverywhereIntent,
  type ProductCopyDraft,
  type StagedVariantImage,
  type TranslateCopyRequest,
} from "./product-form";
import { StagedProductMedia } from "./product-media";

export interface ProductEditorProps {
  /** Absent when creating. */
  readonly product?: Product;
  readonly currency: CurrencyCode;
  /**
   * The media control for an EXISTING product, supplied by the page.
   *
   * Passed in rather than built here because it needs server actions bound to a
   * product that already exists; when creating, this component supplies its own
   * staged uploader instead.
   */
  readonly mediaSlot?: ReactNode;
  /**
   * The products that MAY be offered as add-ons, fetched by the page.
   *
   * Threaded rather than fetched here for the same reason `mediaSlot` is: every
   * admin request belongs on the server side of this boundary, and a client
   * component reaching for the catalogue would move one across it.
   */
  readonly addOnCandidates?: readonly AddOnCandidate[];
  /**
   * The products that MAY be pinned as a pack's components, fetched by the
   * page — same reasoning as `addOnCandidates` immediately above.
   */
  readonly packComponentCandidates?: readonly PackComponentCandidate[];
  /** Pre-selects Simple/Pack on the blank "new product" form. See `ProductForm`. */
  readonly initialKind?: "SIMPLE" | "PACK";
  /**
   * Every live category, fetched by the page — same reasoning as
   * `addOnCandidates` immediately above.
   */
  readonly categories?: readonly Category[];
}

/**
 * The client boundary around the product form.
 *
 * Exists so the page itself stays a server component: it holds the submit/error
 * state and calls the server actions, while every read (the product, its
 * variants, its media) happens server-side. `fetch high, render pure`.
 *
 * Publish and unpublish are SEPARATE actions rather than a status dropdown save,
 * because the API treats them as separate operations with their own rules —
 * publishing requires at least one active variant and at least one translation,
 * and it returns a specific error naming whichever is missing. Folding them into
 * a generic PATCH would replace that message with a validation failure against a
 * field the operator did not touch.
 *
 * THE GRANDFATHERED EXCEPTION ENDS HERE. `lib/admin/actions.ts` names this
 * component as the caller that still read `result.message` — "the API's own
 * English written for a log" — and its own note says new surfaces render `code`
 * instead. This is now a new surface: every failure is translated from the
 * CLOSED `ActionErrorCode`, and `message` is never read. That also removes the
 * `throw new Error(result.message)` that pushed a server string through the
 * form's generic catch and out to an operator.
 *
 * THE DELETE AFFORDANCE IS NO LONGER INSIDE THE EDITOR. It sat one tab-stop
 * from Save; it is now `ProductDangerZone` at the bottom of this file, which the
 * edit page renders in its own hairlined panel beside the sentence about
 * unpublishing every variant. It stays in THIS module because a destructive
 * server action needs a client closure to call it and a translated reason to
 * throw — and the code→copy map those need already lives here.
 */

/**
 * Every failure code, mapped onto the shared `errors` namespace.
 *
 * TOTAL over `ActionErrorCode`, so adding an `ErrorCode` to @akai/contracts
 * fails to compile here until somebody decides what the operator is told.
 * `UNPARSEABLE_RESPONSE` is this client's own sentinel rather than a platform
 * code and has no leaf of its own, so it folds into `generic` — the same call
 * `admin-error-state.tsx` makes about the same sentinel.
 */
const ACTION_ERROR_KEYS: Readonly<Record<ActionErrorCode, string>> = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  RATE_LIMITED: "RATE_LIMITED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  OUT_OF_STOCK: "OUT_OF_STOCK",
  PRICE_CHANGED: "PRICE_CHANGED",
  ILLEGAL_STATE_TRANSITION: "ILLEGAL_STATE_TRANSITION",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UNPARSEABLE_RESPONSE: "generic",
};

/**
 * Every translation failure, mapped onto its own sentence.
 *
 * TOTAL over `TranslateCopyReason`, and that is the point: a reason added to
 * the contract fails to compile here until somebody decides what the operator
 * is told. They need genuinely different sentences — "nobody configured a key"
 * is a permanent state of this deployment, "too many at once" is over in five
 * seconds, "the quota is spent" is neither — and all three arrive as the same
 * coarse CONFLICT, which is exactly why the envelope carries a reason.
 *
 * EXPORTED for its test. The alternative is asserting nine sentences through
 * nine renders of the largest form in the app.
 */
export const TRANSLATE_REASON_KEYS: Readonly<Record<TranslateCopyReason, string>> = {
  NOT_CONFIGURED: "translateErrors.NOT_CONFIGURED",
  INVALID_KEY: "translateErrors.INVALID_KEY",
  QUOTA_EXCEEDED: "translateErrors.QUOTA_EXCEEDED",
  RATE_LIMITED: "translateErrors.RATE_LIMITED",
  UNSUPPORTED_LANGUAGE: "translateErrors.UNSUPPORTED_LANGUAGE",
  VENDOR_UNAVAILABLE: "translateErrors.VENDOR_UNAVAILABLE",
  VENDOR_TIMEOUT: "translateErrors.VENDOR_TIMEOUT",
  MALFORMED_RESPONSE: "translateErrors.MALFORMED_RESPONSE",
  EMPTY_SOURCE: "translateErrors.EMPTY_SOURCE",
};

export function ProductEditor({
  product,
  currency,
  mediaSlot,
  addOnCandidates,
  packComponentCandidates,
  initialKind,
  categories,
}: ProductEditorProps) {
  const t = useTranslations("admin.productForm");
  const tErrors = useTranslations("errors");
  const tCommon = useTranslations("admin.common");

  const [error, setError] = useState<string | undefined>(undefined);
  /**
   * What the fan-out did, as a sentence.
   *
   * SEPARATE FROM `error`, because it reports a DIFFERENT write. The save
   * already succeeded by the time this is set, so folding it into the form's
   * error region would put a success message where an operator reads failures.
   */
  const [notice, setNotice] = useState<string | undefined>(undefined);
  /**
   * Set when the API's sanitiser rewrote the description on this save — see
   * `CONTENT_SANITIZED_HEADER`. SEPARATE from `notice`: this is a warning
   * about what got stored, not a report that a fan-out succeeded, and the two
   * must not silently overwrite one another.
   */
  const [sanitizedWarning, setSanitizedWarning] = useState<string | undefined>(undefined);
  /**
   * Set when one or more variant-level writes (an existing row's edit, its
   * inventory policy, or a newly-added row) fail AFTER the product itself
   * already saved successfully. SEPARATE from `error`: this must never read as
   * "the save failed" — the product-level fields are already stored by the
   * time any of this runs, exactly like `offerEverywhere`'s own failure stays
   * off `error` for the same reason.
   */
  const [variantError, setVariantError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  /**
   * Images chosen before the product exists. Only meaningful while CREATING —
   * an existing product uses the live uploader on its own page, which uploads
   * immediately because it already has an id.
   */
  const [staged, setStaged] = useState<readonly StagedImage[]>([]);
  /**
   * Set once the API says no vendor key is configured here.
   *
   * STICKY, because that answer cannot change while this page is open: the key
   * is read from the API's own environment at boot. Remembering it turns a
   * button that fails every time into one that is disabled beside a sentence
   * saying why — and nothing else on the form is affected, which is the whole
   * of "degrade, do not break".
   */
  const [translateOff, setTranslateOff] = useState<string | null>(null);

  /**
   * `null` code means the throw was not an API failure, so there is no code to
   * map. `reason` is the envelope's own sub-code, checked BEFORE the coarse
   * `code` table below for the two failures that share `FORBIDDEN` but need
   * different sentences (see `AdminErrorState`'s identical branch for a
   * page-load 401/403 — this is that same distinction, for a save).
   *
   * `UNAUTHENTICATED` now reaches an operator ONLY when `adminHttp()`'s own
   * retry-on-401 (§3's fix) ALSO failed to refresh — a genuinely dead session,
   * not the common "token expired mid-form" case the retry already recovers
   * from silently. The sentence therefore says exactly that, reusing the copy
   * `admin.discounts.errors.UNAUTHENTICATED` already used at that one other
   * scope, hoisted here so a THIRD form does not grow its own copy of it.
   */
  function messageFor(code: ActionErrorCode | null, reason?: string | null): string {
    if (code === null) {
      return t("actionFailed");
    }

    if (code === "UNAUTHENTICATED") {
      return tCommon("sessionExpired");
    }

    if (code === "FORBIDDEN") {
      const parsed = authFailureReasonSchema.safeParse(reason);
      if (parsed.success && parsed.data === "TWO_FACTOR_REQUIRED") {
        return tCommon("twoFactorBody");
      }
      if (parsed.success && parsed.data === "TWO_FACTOR_ENROLMENT_REQUIRED") {
        return tCommon("enrolmentBody");
      }
    }

    return tErrors(ACTION_ERROR_KEYS[code]);
  }

  /**
   * The form's translation seam, wired to the server action.
   *
   * THE ACTION IS CALLED HERE rather than in the form, for the reason the whole
   * admin surface works this way: the API bearer lives server-side, and a
   * DeepL-backed endpoint reachable from the browser is a metered vendor with a
   * public door. The form owns the copy; this owns the call and the sentence.
   *
   * IT RETURNS THE COPY; IT DOES NOT SAVE IT. Nothing here calls
   * `updateProductAction`. The operator reads the fill, edits it and saves
   * deliberately — an unreviewed machine translation of customer-facing copy is a
   * compliance failure, not a time saving.
   */
  async function handleTranslate(request: TranslateCopyRequest): Promise<ProductCopyDraft> {
    const result = await translateProductCopyAction({
      from: request.from,
      to: request.to,
      copy: request.copy,
    });

    if (result.ok) {
      return result.data;
    }

    const reason = translateCopyReasonOf(result.reason);
    if (reason === null) {
      // No reason we recognise — a revoked session, an unreadable body, a
      // network failure. The coarse code still has a sentence, and `message`
      // stays where it belongs, in the console.
      throw new TranslateCopyError(messageFor(result.code, result.reason));
    }

    if (reason === "NOT_CONFIGURED") {
      setTranslateOff(t(TRANSLATE_REASON_KEYS[reason]));
    }
    throw new TranslateCopyError(t(TRANSLATE_REASON_KEYS[reason]));
  }

  /**
   * Offer this product on every existing product page, AFTER its own save.
   *
   * A SEPARATE WRITE WITH A SEPARATE FAILURE. The save is what the operator
   * asked for and it has already succeeded by the time this runs, so a failure
   * here must never be reported as "the product was not saved" — it was. It
   * surfaces its own sentence and leaves the save's outcome alone.
   */
  async function offerEverywhere(
    productId: string,
    offer: OfferEverywhereIntent | undefined,
  ): Promise<void> {
    if (offer === undefined || !offer.everywhere) return;

    const result = await offerProductEverywhereAction(productId, {
      defaultVariantId: offer.defaultVariantId,
    });

    if (!result.ok) {
      setError(t("offerEverywhereFailed"));
      return;
    }

    setNotice(
      t("offerEverywhereResult", {
        attached: result.data.attached,
        alreadyPresent: result.data.alreadyPresent,
        skippedAtCap: result.data.skippedAtCap,
      }),
    );
  }

  /**
   * Everything a save on an EXISTING product implies for its variants: rows
   * that changed, rows that are brand new, and any staged photo waiting for
   * the id a new row does not have until `addVariantAction` mints one.
   *
   * FAILURES ARE COLLECTED, NEVER FATAL TO THE REST. The product's own fields
   * are already saved by the time this runs, so one stale-version conflict on
   * a single row must not read as "nothing was saved" — the same reasoning
   * `offerEverywhere`'s own failure handling follows one call up.
   */
  async function applyVariantChanges(
    productId: string,
    changes: ClassifiedVariantChanges,
    variantImages: readonly StagedVariantImage[],
  ): Promise<void> {
    const failedSkus: string[] = [];
    let sawConflict = false;

    function recordFailure(sku: string, code: ActionErrorCode | null): void {
      failedSkus.push(sku);
      if (code === "CONFLICT") {
        sawConflict = true;
      }
    }

    for (const update of changes.updatedVariants) {
      const result = await updateVariantAction(update.variantId, update.patch);
      if (!result.ok) {
        recordFailure(update.sku, result.code);
      }
    }

    for (const policyChange of changes.inventoryPolicyChanges) {
      const result = await setVariantInventoryPolicyAction(
        policyChange.variantId,
        policyChange.policy,
      );
      if (!result.ok) {
        recordFailure(policyChange.sku, result.code);
      }
    }

    // NEW ROWS, THEN THEIR STAGED PHOTOS — mirroring the create flow's own
    // order exactly: a row must exist before a file can attach to it.
    const newVariantIdBySku = new Map<string, string>();
    for (const newVariant of changes.newVariants) {
      const result = await addVariantAction(productId, newVariant);
      if (!result.ok) {
        recordFailure(newVariant.sku, result.code);
        continue;
      }
      newVariantIdBySku.set(result.data.sku, result.data.id);
    }

    for (const staged of variantImages) {
      const variantId = newVariantIdBySku.get(staged.sku);
      if (variantId === undefined) {
        // Not a row this call just created — either it belongs to an existing
        // variant (which uploads immediately through its own "live" control,
        // never through staging) or its creation failed above, in which case
        // there is nothing to attach the photo to.
        continue;
      }

      await uploadProductImage(
        { requestUpload: createMediaUploadUrlAction, attach: addProductMediaAction },
        {
          productId,
          variantId,
          file: staged.image.file,
          alt: altOf(staged.image),
          sortOrder: 0,
        },
      );
      // Not thrown: the variant itself is already saved, and the edit page's
      // live uploader is the recovery surface for a picture that failed.
    }

    if (failedSkus.length > 0) {
      setVariantError(
        sawConflict
          ? t("variantConflict")
          : t("variantSaveFailed", { skus: failedSkus.join(", ") }),
      );
    }
  }

  async function handleSubmit(
    value: CreateProduct,
    variantImages: readonly StagedVariantImage[],
    offer?: OfferEverywhereIntent,
    variantChanges?: ClassifiedVariantChanges,
  ): Promise<void> {
    setError(undefined);
    setNotice(undefined);
    setSanitizedWarning(undefined);
    setVariantError(undefined);

    // SPLIT ON THE OPERATION rather than sharing one `result`. Only a create
    // hands back the variants a staged variant image has to be matched against,
    // and a union of the two action results puts that field behind a narrowing
    // the compiler has no discriminant for.
    if (product !== undefined) {
      const updated = await updateProductAction(product.id, value);
      if (!updated.ok) {
        // Handed DOWN as `formError` rather than thrown. `ProductForm` already
        // owns an alert region wired to the form's `aria-describedby`; throwing
        // would trip its generic catch as well, so the operator would read a
        // specific message stacked on a fallback that says nothing.
        setError(messageFor(updated.code, updated.reason));
        return;
      }

      if (updated.data.sanitizedLocales.length > 0) {
        setSanitizedWarning(t("descriptionSanitized"));
      }

      await offerEverywhere(product.id, offer);

      if (variantChanges !== undefined) {
        await applyVariantChanges(product.id, variantChanges, variantImages);
      }
      return;
    }

    const created = await createProductAction(value);
    if (!created.ok) {
      setError(messageFor(created.code, created.reason));
      return;
    }

    if (created.data.sanitizedLocales.length > 0) {
      setSanitizedWarning(t("descriptionSanitized"));
    }

    const productId = created.data.id;

    // The product exists, so it can be offered elsewhere. Before the image
    // uploads rather than after: those deliberately do not throw, so putting the
    // fan-out behind them would make its outcome depend on how many pictures
    // happened to succeed.
    await offerEverywhere(productId, offer);

    // The product exists now, so its images can finally be uploaded — this is
    // the whole reason they were staged rather than sent with the form.
    //
    // SEQUENTIAL, not Promise.all: `sortOrder` is positional and the storefront
    // shows the lowest, so racing them would make the primary image whichever
    // upload happened to finish first.
    for (const [index, image] of staged.entries()) {
      await uploadProductImage(
        { requestUpload: createMediaUploadUrlAction, attach: addProductMediaAction },
        {
          productId,
          file: image.file,
          alt: altOf(image),
          sortOrder: index,
        },
      );
      // A failed image is NOT thrown: the product is already saved, and
      // undoing that would be worse than landing on its edit page with one
      // picture missing and an uploader right there. The edit page is the
      // recovery surface.
    }

    // The variants exist now too, so the images staged against them finally have
    // ids to attach to.
    //
    // MATCHED BY SKU, NEVER BY POSITION. The API is under no obligation to
    // return the variants in the order they were sent, and an index match would
    // silently put the black photo on the white variant — a failure with no
    // error, discovered by a customer. The SKU is unique and is what the
    // operator typed.
    const variantIdBySku = new Map(
      created.data.variants.map((variant) => [variant.sku, variant.id] as const),
    );

    for (const staged of variantImages) {
      const variantId = variantIdBySku.get(staged.sku);
      if (variantId === undefined) {
        // No variant came back under that SKU, so there is nothing to attach
        // to. Skipped for the same reason a failed upload is skipped below.
        continue;
      }

      await uploadProductImage(
        { requestUpload: createMediaUploadUrlAction, attach: addProductMediaAction },
        {
          productId,
          variantId,
          file: staged.image.file,
          alt: altOf(staged.image),
          // A variant image is not in the gallery, so it has no position among
          // the others: the API partitions the two sets on `variantId`. Zero is
          // the required field's neutral value, not a claim about order.
          sortOrder: 0,
        },
      );
      // Not thrown, for the same reason as above: the product is saved and the
      // edit page carries the same control to retry from.
    }

    // A created product has a new id, so the edit page is a different URL.
    // A HARD assign rather than the router: the id did not exist when this
    // page was rendered, so there is no client cache entry to soft-navigate
    // into and the freshly created product must be read from the API.
    window.location.assign(`/admin/products/${productId}`);
  }

  async function runLifecycle(
    action: (id: string) => Promise<ActionResult<unknown>>,
  ): Promise<void> {
    if (product === undefined) {
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      const result = await action(product.id);
      if (!result.ok) {
        setError(messageFor(result.code, result.reason));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      {product !== undefined && (
        <div className="flex flex-wrap items-center gap-2">
          {product.status === "ACTIVE" ? (
            <Button
              variant="standard"
              size="compact"
              disabled={busy}
              onClick={() => void runLifecycle(unpublishProductAction)}
            >
              {t("unpublish")}
            </Button>
          ) : (
            // `prominent`, not a filled green: publishing is the page's default
            // action, and the emerald button it replaces was a colour this
            // system does not have.
            <Button
              variant="prominent"
              size="compact"
              disabled={busy}
              onClick={() => void runLifecycle(publishProductAction)}
            >
              {t("publish")}
            </Button>
          )}
        </div>
      )}

      {notice !== undefined && (
        <Notice tone="success" placement="inline">
          {notice}
        </Notice>
      )}

      {sanitizedWarning !== undefined && (
        <Notice tone="warning" placement="inline">
          {sanitizedWarning}
        </Notice>
      )}

      {variantError !== undefined && (
        <Notice tone="warning" placement="inline">
          {variantError}
        </Notice>
      )}

      <ProductForm
        previewImages={staged}
        {...(addOnCandidates === undefined ? {} : { addOnCandidates })}
        {...(packComponentCandidates === undefined ? {} : { packComponentCandidates })}
        {...(initialKind === undefined ? {} : { initialKind })}
        {...(categories === undefined ? {} : { categories })}
        {...(product === undefined ? {} : { product })}
        currency={currency}
        onSubmit={handleSubmit}
        onTranslate={handleTranslate}
        // `exactOptionalPropertyTypes`: the prop is absent, never `undefined`.
        {...(translateOff === null ? {} : { translateUnavailable: translateOff })}
        submitLabel={product === undefined ? t("submitCreate") : t("submitSave")}
        {...(error === undefined ? {} : { formError: error })}
        helperText={
          product === undefined && staged.length > 0
            ? t("stagedImages", { count: staged.length })
            : ""
        }
        // The images control. Creating STAGES files until there is an id to
        // presign against; editing hands over the live uploader, which uploads
        // immediately. Same position, two behaviours — which is exactly why the
        // form takes a slot.
        mediaSlot={
          product === undefined ? (
            <StagedProductMedia images={staged} onChange={setStaged} disabled={busy} />
          ) : (
            mediaSlot
          )
        }
        // The per-variant image control, and the same two behaviours for the
        // same reason: creating has no variant id to presign against yet, so the
        // file waits in the form until `handleSubmit` has one. The actions are
        // imported here rather than threaded down from the page because a server
        // action is the one kind of function that may cross into a client
        // component — and this component is already the caller of every other.
        variantImages={
          product === undefined
            ? { mode: "staged" }
            : {
                mode: "live",
                uploads: {
                  productId: product.id,
                  onRequestUpload: createMediaUploadUrlAction,
                  onAttach: addProductMediaAction,
                  onRemove: removeProductMediaAction,
                },
              }
        }
      />
    </div>
  );
}

/**
 * The alt text an upload carries, with a blank locale left out entirely.
 *
 * An empty string is not "no alt text": it is alt text that says nothing, and it
 * would be stored as a per-locale value like any other and rendered into the
 * storefront's `<img alt>`. Omitting the key keeps "we have no Spanish alt for
 * this picture" distinguishable from "the Spanish alt is deliberately empty".
 */
function altOf(image: StagedImage): Record<string, string> {
  const es = image.altEs.trim();
  const en = image.altEn.trim();

  return {
    ...(es === "" ? {} : { es }),
    ...(en === "" ? {} : { en }),
  };
}

/**
 * The danger zone: the drawn `--danger-ring` panel and the delete it guards.
 *
 * A CLIENT COMPONENT, and it has to be. `DeleteProductButton` takes an
 * `onConfirm` closure, and a closure cannot be handed from a server component to
 * a client one — only a server action can cross, and a server action that throws
 * reaches the browser as an opaque digest rather than as the translated reason
 * the dialog is supposed to show. So the page renders this, and this calls the
 * action.
 *
 * The trigger is a STANDARD button with red ink (`destructivePlain`), not a
 * filled red one: the confirmation is what makes the action safe, and a solid
 * red button beside a form nobody has touched is the loudest thing on the page
 * for no reason.
 */
export interface ProductDangerZoneProps {
  readonly productId: string;
  /** The phrase the operator has to type. */
  readonly productSlug: string;
}

export function ProductDangerZone({ productId, productSlug }: ProductDangerZoneProps) {
  const t = useTranslations("admin.productForm");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  return (
    <section className="grid gap-2 rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-[var(--card-p)] shadow-[0_0_0_1px_var(--danger-ring)]">
      <h2 className="m-0 text-[13px] font-semibold text-[var(--danger-text)]">
        {t("dangerZone")}
      </h2>
      {/* The consequence, stated where the button is rather than only inside the
          dialog: deleting unpublishes every variant, and an operator deciding
          whether to press it should not have to open it to find that out. */}
      <p className="m-0 text-[12px] leading-4 text-[var(--label)]">{t("dangerZoneBody")}</p>
      <div className="justify-self-start">
        <DeleteProductButton
          productSlug={productSlug}
          onConfirm={async () => {
            const result = await deleteProductAction(productId);
            if (!result.ok) {
              // A code we can name becomes a specific, translated reason. A
              // failure with no code has nothing to add beyond the dialog's own
              // fallback, so it throws a plain Error — which the dialog swaps
              // for `fallbackError` rather than rendering. Either way the API's
              // English never reaches the operator.
              if (result.code === null) {
                throw new Error("product delete failed");
              }
              throw new ConfirmActionError(tErrors(ACTION_ERROR_KEYS[result.code]));
            }
            router.push("/admin/products");
            router.refresh();
          }}
        />
      </div>
    </section>
  );
}
