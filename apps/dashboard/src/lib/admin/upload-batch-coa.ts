import type { ActionResult } from "./actions";

/**
 * The two-step COA upload, in one place — presign, then PUT straight to
 * storage. Mirrors `uploadProductImage`'s shape exactly, minus what's
 * image-specific: no dimensions to measure, no alt text, no gallery
 * `sortOrder` (a variant carries at most one batch on screen at a time).
 *
 * The file never passes through this app or the API — the signed URL grants
 * exactly one PUT to exactly one object key, the same as a product photo.
 */

export const MAX_COA_BYTES = 10 * 1024 * 1024;

/** The one content type the API's `createCoaUploadUrlSchema` accepts. */
export const ACCEPTED_COA_TYPE = "application/pdf";

export type CoaUploadFailure =
  | "tooLarge"
  | "notAPdf"
  | "signFailed"
  | "uploadFailed"
  | "attachFailed";

export type CoaUploadOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CoaUploadFailure };

export interface CoaUploadDeps {
  readonly requestUpload: (input: {
    batchId: string;
    sizeBytes: number;
  }) => Promise<ActionResult<{ uploadUrl: string; objectKey: string }>>;
  readonly attach: (
    batchId: string,
    input: { objectKey: string },
  ) => Promise<ActionResult<unknown>>;
}

export async function uploadBatchCoa(
  deps: CoaUploadDeps,
  input: { batchId: string; file: File },
): Promise<CoaUploadOutcome> {
  return uploadCoaPdf(
    {
      requestUpload: (sizeBytes) => deps.requestUpload({ batchId: input.batchId, sizeBytes }),
      attach: (objectKey) => deps.attach(input.batchId, { objectKey }),
    },
    input.file,
  );
}

/**
 * The target-agnostic core, shared by a lot's certificate (above) and the
 * PRODUCT's certificate (`ProductCoaField`). The caller binds the target id
 * into both closures, so the one ordering rule — bytes stored BEFORE the key
 * is recorded — lives in exactly one function.
 */
export interface CoaPdfUploadDeps {
  readonly requestUpload: (
    sizeBytes: number,
  ) => Promise<ActionResult<{ uploadUrl: string; objectKey: string }>>;
  readonly attach: (objectKey: string) => Promise<ActionResult<unknown>>;
}

export async function uploadCoaPdf(deps: CoaPdfUploadDeps, file: File): Promise<CoaUploadOutcome> {
  if (file.size > MAX_COA_BYTES) {
    return { ok: false, reason: "tooLarge" };
  }

  if (file.type !== ACCEPTED_COA_TYPE) {
    return { ok: false, reason: "notAPdf" };
  }

  const signed = await deps.requestUpload(file.size);
  if (!signed.ok) {
    return { ok: false, reason: "signFailed" };
  }

  // No bearer: the signed URL carries its own authority, and the admin token
  // must never reach the browser's network tab.
  const stored = await fetch(signed.data.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": ACCEPTED_COA_TYPE },
    body: file,
  });
  if (!stored.ok) {
    return { ok: false, reason: "uploadFailed" };
  }

  // ONLY after the bytes are in storage. The reverse order records a
  // certificate the bucket does not hold.
  const attached = await deps.attach(signed.data.objectKey);

  return attached.ok ? { ok: true } : { ok: false, reason: "attachFailed" };
}
