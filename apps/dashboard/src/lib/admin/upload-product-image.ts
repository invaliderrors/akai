import type { ActionResult } from "./actions";

/**
 * The three-step upload, in one place.
 *
 * Presign → PUT straight to storage → record against the product. Shared by the
 * edit page's media manager and the create form's staged images, because getting
 * the ORDER wrong is the failure that matters: recording before the bytes land
 * produces a product row pointing at a 404, and no test of either caller alone
 * would notice a second copy drifting.
 *
 * The file never passes through this app or the API — the signed URL grants
 * exactly one PUT to exactly one object key.
 */

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Formats the API accepts. */
export const ACCEPTED_IMAGE_TYPES = "image/png,image/jpeg,image/webp";

export type UploadFailure =
  | "tooLarge"
  | "notAnImage"
  | "signFailed"
  | "uploadFailed"
  | "attachFailed";

export type UploadOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: UploadFailure };

export interface UploadDeps {
  readonly requestUpload: (input: {
    productId: string;
    contentType: string;
    sizeBytes: number;
  }) => Promise<ActionResult<{ uploadUrl: string; objectKey: string; publicUrl: string }>>;
  readonly attach: (
    productId: string,
    input: {
      objectKey: string;
      url: string;
      alt: Record<string, string>;
      width: number;
      height: number;
      sortOrder: number;
      /**
       * Attach to ONE variant rather than to the product gallery.
       *
       * Optional because the gallery is the ordinary case and a variant image
       * is the exception. It is declared HERE, on the dependency, as well as on
       * the action it stands for, so a caller that wraps `attach` to inject the
       * id — which is how the variant control reuses `MediaUploader` — is
       * type-checked against the same shape the action accepts.
       */
      variantId?: string;
    },
  ) => Promise<ActionResult<{ id: string }>>;
}

/**
 * Reads a decoded image's intrinsic size, releasing the object URL either way.
 *
 * A file the browser cannot decode is not an image, whatever its MIME type
 * claims — refusing here beats storing an object nothing renders.
 */
export async function measureImage(file: File): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve(null);
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadProductImage(
  deps: UploadDeps,
  input: {
    productId: string;
    file: File;
    alt: Record<string, string>;
    sortOrder: number;
    /** Set to attach the object to one variant rather than to the gallery. */
    variantId?: string;
  },
): Promise<UploadOutcome> {
  if (input.file.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: "tooLarge" };
  }

  const dimensions = await measureImage(input.file);
  if (dimensions === null) {
    return { ok: false, reason: "notAnImage" };
  }

  const signed = await deps.requestUpload({
    productId: input.productId,
    contentType: input.file.type,
    sizeBytes: input.file.size,
  });
  if (!signed.ok) {
    return { ok: false, reason: "signFailed" };
  }

  // No bearer: the signed URL carries its own authority, and the admin token
  // must never reach the browser's network tab.
  const stored = await fetch(signed.data.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": input.file.type },
    body: input.file,
  });
  if (!stored.ok) {
    return { ok: false, reason: "uploadFailed" };
  }

  // ONLY after the bytes are in storage. The reverse order records a URL that
  // 404s until the PUT lands, if it ever does.
  const attached = await deps.attach(input.productId, {
    objectKey: signed.data.objectKey,
    url: signed.data.publicUrl,
    alt: input.alt,
    width: dimensions.width,
    height: dimensions.height,
    sortOrder: input.sortOrder,
    // Spread rather than passed as `variantId: input.variantId`:
    // `exactOptionalPropertyTypes` makes an explicit `undefined` a type error
    // on an optional key, and the API's `.strict()` schema would see the key.
    ...(input.variantId === undefined ? {} : { variantId: input.variantId }),
  });

  return attached.ok ? { ok: true } : { ok: false, reason: "attachFailed" };
}
