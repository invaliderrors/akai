import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "@akai/contracts";

/**
 * Batch/COA admin DTOs.
 *
 * Declared locally rather than in @akai/contracts, same reasoning as
 * `media.dto.ts`: these describe an ADMIN write with no storefront consumer.
 * The public catalog reads `publicBatchSchema` (the lot record minus any COA
 * URL), which contracts already owns and which this module never redefines.
 *
 * THE COA UPLOAD SCHEMAS ARE SHARED. `createCoaUploadUrlSchema`,
 * `attachCoaSchema` and `CoaUploadUrlResponse` are also the request/response
 * shapes of the PRODUCT certificate routes on `AdminProductsController`
 * (`POST /v1/admin/products/:id/coa/...`), so a lot's PDF and a product's PDF
 * cannot drift apart on content type or size ceiling.
 */

/**
 * Record a new lot for a variant.
 *
 * NO `variantId` HERE — it travels in the route, not the body, matching every
 * other nested-resource write in this API (`admin/products/variants/:variantId/...`).
 */
export const createBatchSchema = z
  .object({
    lotCode: z.string().min(1).max(64),
    purityPercent: z.number().min(0).max(100),
    testedAt: isoDateTimeSchema,
    testMethod: z.string().min(1).max(64),
  })
  .strict();

export type CreateBatch = z.infer<typeof createBatchSchema>;

/**
 * PDF only, a closed set of exactly one — the same security control
 * `uploadContentTypeSchema` applies to images, for the same reason: the
 * content type is trusted to describe what actually gets served back, and a
 * certificate of analysis has no legitimate reason to be anything else.
 */
export const coaContentTypeSchema = z.literal("application/pdf");

/**
 * Request a signed upload URL for one batch's COA.
 *
 * NOTE WHAT IS ABSENT: the object key, same reasoning as media uploads — the
 * server derives it from the batch id and a random suffix so a caller cannot
 * choose where the file lands.
 */
export const createCoaUploadUrlSchema = z
  .object({
    sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  })
  .strict();

export type CreateCoaUploadUrl = z.infer<typeof createCoaUploadUrlSchema>;

/**
 * The signed URL and the key it writes to.
 *
 * NO `publicUrl`, unlike media's response — `S3_BUCKET_COA` carries no
 * anonymous-download policy, so there is no bare path worth returning; the
 * object is read back through a signed URL minted per request — `coaUrl` on
 * an ADMIN catalog read. A lot's certificate is admin data: the public
 * `GET /v1/products/:slug/coa` redirect serves the PRODUCT's certificate.
 */
export const coaUploadUrlResponseSchema = z
  .object({
    uploadUrl: z.string().url(),
    objectKey: z.string().min(1),
    expiresInSeconds: z.number().int().positive(),
  })
  .strict();

export type CoaUploadUrlResponse = z.infer<typeof coaUploadUrlResponseSchema>;

/**
 * Finalize an upload: record the key an upload succeeded to.
 *
 * TWO STEPS, not one — same split as media, and the same reason: an upload
 * that fails midway leaves an orphaned object in the bucket rather than a
 * batch that believes it has a certificate it does not.
 */
export const attachCoaSchema = z
  .object({
    objectKey: z.string().min(1),
  })
  .strict();

export type AttachCoa = z.infer<typeof attachCoaSchema>;

/** Route param shape, shared by every batch-scoped route below `batches/:batchId`. */
export const batchIdParamSchema = z.object({ batchId: idSchema }).strict();
