"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import type { MediaAsset } from "@akai/contracts";

import { Button, IconButton } from "@/components/ui/button";
import {
  MediaUploader,
  type MediaUploaderLabels,
  type ProductMediaItem,
  type StagedImage,
} from "@/components/ui/media-uploader";
import { Dialog } from "@/components/ui/overlay";
import type { ActionResult } from "@/lib/admin/actions";
import type { UploadDeps } from "@/lib/admin/upload-product-image";

import { useMediaLabels } from "./product-media";

/**
 * The one image a VARIANT may carry, as a control that fits in a table cell.
 *
 * WHY IT IS A CELL PLUS A DIALOG, and not the uploader inline. The variant
 * table's whole point is that one variant costs about 150px: the column header
 * carries the label and the cell carries the control. An uploader inline —
 * a thumbnail grid, a dropzone and an alt-text field — is roughly 260px of
 * height PER ROW, which would undo the density pass that built the table. So
 * the cell holds a 24px affordance and the editing happens in a modal.
 *
 * A `Dialog` RATHER THAN A `Popover`, and that is mechanical rather than a
 * taste call: the variant table lives inside `overflow-x-auto`, and `overflow-x`
 * computes `overflow-y` to `auto` as well, so an absolutely positioned panel
 * anchored in a cell is clipped by the scroller it sits in. `Dialog` portals to
 * `document.body`, which is the only way out of that box.
 *
 * IT REUSES `MediaUploader` IN BOTH MODES rather than growing a third uploader.
 * This repo has just finished merging two product-image pickers into one; the
 * only things a variant image needs that the merge did not already provide are
 * the cell affordance, the `variantId` on the attach, and the cap of one image.
 * Everything else — the presign → PUT → attach ordering, the alt text,
 * the undo on removal, the progress phases — comes from the component that
 * already owns it and is already tested.
 *
 * THE ACCESSIBLE NAMES ALL NAME THE VARIANT. A column header does not name a
 * cell for a screen reader moving cell by cell, so "Añadir imagen" repeated down
 * a column would be nine identically-named buttons. Every control here is named
 * with the variant it belongs to — its SKU once the operator has typed one, and
 * its row heading until then.
 */

/** The server actions a live attach needs, bound to a product that exists. */
export interface VariantImageUploads {
  readonly productId: string;
  readonly onRequestUpload: UploadDeps["requestUpload"];
  readonly onAttach: UploadDeps["attach"];
  readonly onRemove: (productId: string, mediaId: string) => Promise<ActionResult<unknown>>;
}

/**
 * How the variant images on THIS form behave, decided by the caller.
 *
 * `staged` while the product is being created: the presign endpoint is scoped to
 * a productId, so nothing can be uploaded before the product row exists and the
 * file waits in the browser. `live` once it does: presign → PUT → attach, at the
 * moment the operator presses upload.
 */
export type VariantImageSupport =
  | { readonly mode: "staged" }
  | { readonly mode: "live"; readonly uploads: VariantImageUploads };

interface VariantImageFieldBaseProps {
  /**
   * WHICH variant this control belongs to, already resolved to something an
   * operator recognises (a SKU, or "Variante 2"). It goes into the accessible
   * name of every control this component renders.
   */
  readonly variantName: string;
  readonly disabled?: boolean;
}

export interface StagedVariantImageFieldProps extends VariantImageFieldBaseProps {
  readonly mode: "staged";
  /** The file chosen so far, or none. The form owns it until the product exists. */
  readonly image: StagedImage | null;
  readonly onChange: (image: StagedImage | null) => void;

  // Present-and-undefined so a live prop cannot be passed into staged mode:
  // TypeScript's excess-property check accepts a key that appears in ANY member
  // of a union, so without these `mode="staged" uploads={…}` would compile and
  // the uploads would be silently dropped. Same guard `MediaUploader` uses.
  readonly variantId?: undefined;
  readonly asset?: undefined;
  readonly uploads?: undefined;
}

export interface LiveVariantImageFieldProps extends VariantImageFieldBaseProps {
  readonly mode: "live";
  readonly variantId: string;
  /** What the server currently holds for this variant. */
  readonly asset: MediaAsset | null;
  readonly uploads: VariantImageUploads;

  readonly image?: undefined;
  readonly onChange?: undefined;
}

export type VariantImageFieldProps =
  | StagedVariantImageFieldProps
  | LiveVariantImageFieldProps;

export function VariantImageField(props: VariantImageFieldProps) {
  const t = useTranslations("admin.variantImage");
  const tUi = useTranslations("ui");
  const base = useMediaLabels();
  const headingId = useId();
  const [open, setOpen] = useState(false);

  const { variantName, disabled = false } = props;

  /**
   * The product uploader's labels, with the three that would be wrong here
   * replaced.
   *
   * `primary` in particular: `MediaUploader` badges the first tile "Principal",
   * which is true of a gallery — the storefront shows the lowest sortOrder — and
   * false of a variant, whose single image is not the product's main one. The
   * other twenty-odd strings (alt text, upload, remove, every failure) are the
   * same words for the same actions and are reused rather than retyped.
   */
  const labels: MediaUploaderLabels = {
    ...base,
    empty: t("empty"),
    stagedHint: t("stagedHint"),
    primary: t("badge"),
  };

  const previewUrl =
    props.mode === "staged" ? (props.image?.previewUrl ?? null) : (props.asset?.url ?? null);

  return (
    <>
      {previewUrl === null ? (
        <IconButton
          label={t("add", { variant: variantName })}
          icon="plus"
          variant="standard"
          size="mini"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        />
      ) : (
        // The thumbnail IS the trigger: a 24px picture beside a 24px button
        // would be two controls for one thing, in the cell that is supposed to
        // stay narrow.
        <button
          type="button"
          aria-label={t("change", { variant: variantName })}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="inline-flex size-6 overflow-hidden rounded-[var(--r-check)] shadow-[var(--ring-control)] focus-visible:outline-none focus-visible:shadow-[var(--ring-control),0_0_0_4px_var(--focus-ring)] disabled:opacity-60"
        >
          {/* A plain <img>: an admin thumbnail, often a local object URL for a
              file picked a second ago, so there is nothing for next/image to
              optimise and using it would mean listing every storage host in this
              app's remotePatterns. Decorative — the button is named above. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
          <img src={previewUrl} alt="" className="size-full object-cover" />
        </button>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        labelledBy={headingId}
        surface="opaque"
      >
        <div className="grid gap-3 p-4">
          <div className="grid gap-0.5">
            <h2 id={headingId} className="m-0 text-[15px] font-semibold text-[var(--label)]">
              {t("title", { variant: variantName })}
            </h2>
            <p className="m-0 text-[11px] leading-4 text-[var(--label-secondary)]">
              {t("hint")}
            </p>
          </div>

          {props.mode === "staged" ? (
            <MediaUploader
              mode="staged"
              images={props.image === null ? [] : [props.image]}
              // ONE image, enforced where the value is written rather than by
              // hiding the picker: a variant has exactly one image, so a second
              // file dropped onto the same control replaces nothing and is
              // dropped. `images[0]` is `StagedImage | undefined` under
              // `noUncheckedIndexedAccess`, which is the removal case.
              onChange={(images) => props.onChange(images[0] ?? null)}
              labels={labels}
              disabled={disabled}
            />
          ) : (
            <MediaUploader
              mode="live"
              productId={props.uploads.productId}
              items={props.asset === null ? [] : [toMediaItem(props.asset)]}
              onRequestUpload={props.uploads.onRequestUpload}
              // WRAPPED to inject the variant. `uploadProductImage` builds the
              // attach body and knows nothing about variants; wrapping here is
              // the same seam `MediaUploader` itself uses to observe the save
              // phase, and it keeps the presign → PUT → attach ordering in the
              // one file that guarantees it.
              onAttach={(productId, input) =>
                props.uploads.onAttach(productId, { ...input, variantId: props.variantId })
              }
              onRemove={props.uploads.onRemove}
              labels={labels}
              disabled={disabled}
            />
          )}

          <div className="justify-self-end">
            <Button variant="standard" size="compact" onClick={() => setOpen(false)}>
              {tUi("close")}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** A contract `MediaAsset` as the uploader's own item shape. */
function toMediaItem(asset: MediaAsset): ProductMediaItem {
  return {
    id: asset.id,
    url: asset.url,
    alt: asset.alt,
    width: asset.width,
    height: asset.height,
    sortOrder: asset.sortOrder,
  };
}
