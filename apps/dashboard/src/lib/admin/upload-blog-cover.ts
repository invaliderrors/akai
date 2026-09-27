import { imageUploadContentTypeSchema, type ImageUploadContentType } from "@akai/contracts";

import type { ActionResult } from "./actions";
import { MAX_IMAGE_BYTES, type UploadFailure, type UploadOutcome } from "./upload-product-image";

/**
 * Put a cover image on a blog post: sign, PUT, then record the key.
 *
 * THE SAME THREE-STEP ORDER as `uploadProductImage`, for the same reason: the
 * key is recorded on the post only AFTER the bytes are in storage, so a failed
 * upload never leaves a post pointing at an object that 404s. The browser PUTs
 * straight to storage with the signed URL; the admin bearer never reaches it.
 *
 * Injected dependencies (server actions in the app, fakes in tests), so the
 * ordering and the failure mapping are testable without a network.
 */
export interface BlogCoverUploadDeps {
  readonly requestUpload: (
    postId: string,
    input: { contentType: ImageUploadContentType; sizeBytes: number },
  ) => Promise<ActionResult<{ uploadUrl: string; objectKey: string; publicUrl: string }>>;
  readonly attach: (postId: string, coverObjectKey: string) => Promise<ActionResult<unknown>>;
}

export async function uploadBlogCover(
  deps: BlogCoverUploadDeps,
  input: { readonly postId: string; readonly file: File },
): Promise<UploadOutcome> {
  if (input.file.size > MAX_IMAGE_BYTES) return failed("tooLarge");
  // The API's own whitelist, parsed rather than pattern-matched, so the type
  // handed to the signer is the narrowed enum and can never drift from it.
  const contentType = imageUploadContentTypeSchema.safeParse(input.file.type);
  if (!contentType.success) return failed("notAnImage");

  const signed = await deps.requestUpload(input.postId, {
    contentType: contentType.data,
    sizeBytes: input.file.size,
  });
  if (!signed.ok) return failed("signFailed");

  const stored = await fetch(signed.data.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": input.file.type },
    body: input.file,
  });
  if (!stored.ok) return failed("uploadFailed");

  const attached = await deps.attach(input.postId, signed.data.objectKey);
  return attached.ok ? { ok: true } : failed("attachFailed");
}

function failed(reason: UploadFailure): UploadOutcome {
  return { ok: false, reason };
}
