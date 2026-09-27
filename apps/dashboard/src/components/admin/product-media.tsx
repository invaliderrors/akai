"use client";

import { useTranslations } from "next-intl";

import {
  MediaUploader,
  type MediaUploaderLabels,
  type ProductMediaItem,
  type StagedImage,
} from "@/components/ui/media-uploader";
import type { ActionResult } from "@/lib/admin/actions";
import type { UploadDeps } from "@/lib/admin/upload-product-image";

/**
 * The product surface's copy for `ui/media-uploader`, bound once.
 *
 * WHY THIS FILE EXISTS AT ALL, and why the label table is not simply inlined at
 * the two call sites: three of `MediaUploaderLabels`' entries are FUNCTIONS
 * (`remove(name)`, `reorder(position)`, `select(name)`), and a function prop
 * cannot cross the server/client boundary — React rejects anything but a server
 * action. The edit page is an async server component, so it could not build this
 * object even if we were willing to write it twice. One client module owns the
 * table, both modes read it, and the two cannot drift.
 *
 * The uploader takes every string as a prop by design, because the copy it needs
 * is split across two namespaces: `admin.productMedia` (the product-specific
 * wording) and `ui` (the shared a11y labels every kit surface uses). That split
 * is resolved here, once.
 *
 * MOUNTED INSIDE `<ToastProvider>` — `DashboardShell` supplies it for every
 * signed-in page, and `useToast` throws without one, deliberately: a removal
 * offering an undo nobody can see is worse than a loud crash in development.
 */
export function useMediaLabels(): MediaUploaderLabels {
  const media = useTranslations("admin.productMedia");
  const ui = useTranslations("ui");

  return {
    empty: media("empty"),
    stagedHint: media("stagedHint"),
    primary: ui("primary"),
    remove: (name) => ui("remove", { name }),
    removed: ui("removed"),
    undo: ui("undo"),
    reorder: ({ name, index, total }) => ui("reorder", { name, index, total }),
    select: (name) => ui("select", { name }),
    uploading: media("uploading"),
    saving: ui("saving"),
    upload: ui("upload"),
    altHeading: ui("altHeading"),
    altEs: ui("altEs"),
    altEn: ui("altEn"),
    altRequired: ui("altRequired"),
    errors: {
      // Total over `MediaUploaderError`, which is `UploadFailure` plus this
      // component's own three — so a new failure mode in the upload lib is a
      // compile error here rather than a blank message under a broken picture.
      tooLarge: media("errors.tooLarge"),
      notAnImage: media("errors.notAnImage"),
      signFailed: media("errors.signFailed"),
      uploadFailed: media("errors.uploadFailed"),
      attachFailed: media("errors.attachFailed"),
      removeFailed: media("errors.removeFailed"),
      reorderFailed: ui("reorderFailed"),
      generic: media("errors.generic"),
    },
  };
}

export interface StagedProductMediaProps {
  /** Files chosen before the product exists. The order IS the value. */
  readonly images: readonly StagedImage[];
  readonly onChange: (images: readonly StagedImage[]) => void;
  readonly disabled?: boolean;
}

/**
 * Images for a product that does not exist yet.
 *
 * Nothing is uploaded: the presign endpoint is scoped to a `productId` and no
 * object key can be issued before the product row does. The files sit in the
 * browser until the create succeeds, and `ProductEditor` uploads them then.
 */
export function StagedProductMedia({ images, onChange, disabled }: StagedProductMediaProps) {
  const labels = useMediaLabels();

  return (
    <MediaUploader
      mode="staged"
      images={images}
      onChange={onChange}
      labels={labels}
      {...(disabled === undefined ? {} : { disabled })}
    />
  );
}

export interface LiveProductMediaProps {
  readonly productId: string;
  readonly items: readonly ProductMediaItem[];
  /** Server actions, which ARE allowed to cross from the page's server component. */
  readonly onRequestUpload: UploadDeps["requestUpload"];
  readonly onAttach: UploadDeps["attach"];
  readonly onRemove: (productId: string, mediaId: string) => Promise<ActionResult<unknown>>;
}

/**
 * Images for a product that already exists: presign → PUT → attach, immediately.
 *
 * NO `onReorder`. The API exposes exactly three media routes — presign, attach,
 * delete — and none of them reorders, so the uploader hides its grips rather
 * than offering a handle that moves a tile the server will re-sort on the next
 * render. Staged mode always has handles, because there the order is local.
 */
export function LiveProductMedia({
  productId,
  items,
  onRequestUpload,
  onAttach,
  onRemove,
}: LiveProductMediaProps) {
  const labels = useMediaLabels();

  return (
    <MediaUploader
      mode="live"
      productId={productId}
      items={items}
      onRequestUpload={onRequestUpload}
      onAttach={onAttach}
      onRemove={onRemove}
      labels={labels}
    />
  );
}
