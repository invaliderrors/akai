import { z } from "zod";

/**
 * The Sendcloud webhook body, parsed LOOSELY — and only after the signature holds.
 *
 * The payload is the legacy v2 parcel shape with a numeric status id and may
 * arrive out of order (spec §1 S13), so it is used as a TRIGGER only: we read
 * which parcel changed and when, then re-read the parcel's current state from
 * v3. Nothing else in the body is trusted or even looked at, so nothing else is
 * parsed — a whitelist of three fields cannot break on an additive vendor
 * change, and a status we would have to translate from v2 ids is a status we
 * could get wrong.
 *
 * Not `.strict()`: this is an inbound vendor payload (the DeepL/Sendcloud client
 * reasoning), and the parcel object carries dozens of fields we drop.
 */

/** Only this action names a parcel whose state changed. */
export const SENDCLOUD_PARCEL_STATUS_CHANGED = "parcel_status_changed";

/**
 * A parcel id: a JSON integer in practice, accepted as a digit string too.
 * Converted to `bigint` because the column is BIGINT and a 64-bit id must not
 * round through a double.
 */
const parcelIdSchema = z
  .union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d{1,19}$/)])
  .transform((value) => BigInt(value));

/** Epoch milliseconds as Sendcloud sends it; a string form is tolerated. */
const timestampSchema = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)])
  .transform((value) => String(value));

export const sendcloudWebhookSchema = z.object({
  action: z.string().min(1).max(64),
  timestamp: timestampSchema.optional(),
  parcel: z
    .object({
      id: parcelIdSchema,
      tracking_number: z.string().max(128).nullish(),
    })
    .optional(),
});

export type SendcloudWebhookBody = z.infer<typeof sendcloudWebhookSchema>;
