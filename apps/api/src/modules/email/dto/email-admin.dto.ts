import { z } from "zod";
import {
  emailSchema,
  emailStatusSchema,
  emailTemplateKeySchema,
  idSchema,
} from "@akai/contracts";

/**
 * Request DTOs for the admin email surface.
 *
 * zod, not class-validator (spec §7): the idiomatic `@IsString() name!: string`
 * needs a definite-assignment `!` on every field, which is indistinguishable
 * from the banned non-null assertion. These schemas are the validator, the
 * static type and the OpenAPI fragment at once.
 *
 * Every one is `.strict()` — an unknown key is REJECTED, not dropped. On an
 * admin surface that matters more than usual: these values are used to build
 * Prisma `where` clauses, and a silently-accepted extra key is how a filter
 * someone did not intend ends up in a query.
 */

export const listEmailEventsQuerySchema = z
  .object({
    cursor: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: emailStatusSchema.optional(),
    templateKey: emailTemplateKeySchema.optional(),
    /** Exact-match only. A substring search here would be a PII fishing tool. */
    recipient: emailSchema.optional(),
  })
  .strict();

export type ListEmailEventsQuery = z.infer<typeof listEmailEventsQuerySchema>;

export const emailEventIdParamSchema = z.object({ id: idSchema }).strict();
export type EmailEventIdParam = z.infer<typeof emailEventIdParamSchema>;

/**
 * Retry body.
 *
 * The payload must be re-supplied because `email_event` stores the delivery
 * RECORD, not the rendered body or its inputs — deliberately, since a template
 * payload contains the customer's name, address-adjacent data and order
 * contents, and persisting it would duplicate that PII into a second table with
 * a different retention story.
 *
 * It arrives as an opaque record and is parsed against the schema for the
 * template key on the STORED event, never a key supplied by the caller. That
 * ordering matters: letting the request name the template would let an operator
 * render an arbitrary template with arbitrary content and mail it to the
 * address on record.
 */
export const retryEmailBodySchema = z
  .object({
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type RetryEmailBody = z.infer<typeof retryEmailBodySchema>;

export const suppressionEmailParamSchema = z.object({ email: emailSchema }).strict();
export type SuppressionEmailParam = z.infer<typeof suppressionEmailParamSchema>;
