import { z } from "zod";
import { IMAGE_UPLOAD_MAX_BYTES, idSchema, imageUploadContentTypeSchema } from "@akai/contracts";

/**
 * Media upload DTOs.
 *
 * Declared locally rather than in @akai/contracts because they describe an
 * ADMIN operation with no storefront consumer; the public catalog only ever
 * reads `mediaAssetSchema`, which contracts already owns. Promote them if a
 * second client ever needs to upload.
 */

/**
 * Image content types we are willing to host.
 *
 * A CLOSED SET, and that is the security control, not a convenience. The content
 * type is baked into the signed URL's object key extension and is what the CDN
 * will eventually serve with; allowing `text/html` or `image/svg+xml` would let
 * an admin upload a document that executes JavaScript on our own origin. SVG is
 * excluded deliberately despite being an image format, for exactly that reason.
 *
 * The enum itself now lives in @akai/contracts (`imageUploadContentTypeSchema`)
 * because the blog cover upload (`POST /admin/blog/posts/:id/cover/upload-url`)
 * is a second consumer that must apply the SAME whitelist — two copies of a
 * security allow-list is how one of them grows an `image/svg+xml`.
 */
export const uploadContentTypeSchema = imageUploadContentTypeSchema;

export type UploadContentType = z.infer<typeof uploadContentTypeSchema>;

/** Extension per content type. One mapping, so the key and the type agree. */
export const CONTENT_TYPE_EXTENSIONS: Readonly<Record<UploadContentType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

/**
 * Request a signed upload URL.
 *
 * NOTE WHAT IS ABSENT: the object key. The client cannot choose where the file
 * lands — the server derives the key from the product id and a random suffix.
 * A client-supplied key is a path-traversal and an overwrite primitive: a
 * caller could write `../../backups/db.sql` or clobber another product's hero
 * image, and the signature would faithfully authorise it.
 */
export const createUploadUrlSchema = z
  .object({
    productId: idSchema,
    contentType: uploadContentTypeSchema,
    /**
     * Declared size, used ONLY to reject an obviously-oversized upload before a
     * URL is issued. It is not a security control — the browser can send more
     * than it declared — so the bucket must also carry a size policy. It saves
     * the round trip in the common, honest case.
     */
    sizeBytes: z.number().int().positive().max(IMAGE_UPLOAD_MAX_BYTES),
  })
  .strict();

export type CreateUploadUrl = z.infer<typeof createUploadUrlSchema>;

/**
 * The signed URL and the key it writes to.
 *
 * `objectKey` is returned because the caller must hand it back to
 * `POST /v1/admin/products/:id/media` once the upload completes — that route
 * takes an already-hosted asset and has no way to learn the key otherwise.
 */
export const uploadUrlResponseSchema = z
  .object({
    uploadUrl: z.string().url(),
    objectKey: z.string().min(1),
    /** Where the object will be readable once uploaded. */
    publicUrl: z.string().url(),
    expiresInSeconds: z.number().int().positive(),
  })
  .strict();

export type UploadUrlResponse = z.infer<typeof uploadUrlResponseSchema>;
