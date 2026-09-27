import { z } from "zod";
import {
  emailStatusSchema,
  emailTemplateKeySchema,
  inventoryMovementSchema,
  roleSchema,
} from "./enums";
import { emailSchema, idSchema, isoDateTimeSchema, localeSchema } from "./common";

/**
 * Operational records: email log, audit log, inventory ledger, ports.
 */

/**
 * One transactional send.
 *
 * Sends are idempotent per (orderId, templateKey) — that unique pair is what
 * stops a provider webhook retry from mailing three order confirmations. The
 * uniqueness is enforced in the DB, not in application code.
 */
export const emailEventSchema = z
  .object({
    id: idSchema,
    recipient: emailSchema,
    templateKey: emailTemplateKeySchema,
    locale: localeSchema,
    status: emailStatusSchema,
    /** Provider-side id, needed to correlate bounce/complaint webhooks. */
    providerMessageId: z.string().max(200).nullable(),
    orderId: idSchema.nullable(),
    error: z.string().max(1000).nullable(),
    attempts: z.number().int().min(0),
    sentAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type EmailEvent = z.infer<typeof emailEventSchema>;

/**
 * The EmailPort. Declared here (spec §10) so the API depends on an interface,
 * the worker binds Resend, and tests bind a fake from @akai/testing. No test
 * can reach a real inbox because no test ever sees the Resend adapter.
 */
export interface SendEmailInput {
  readonly to: string;
  readonly templateKey: z.infer<typeof emailTemplateKeySchema>;
  readonly locale: z.infer<typeof localeSchema>;
  /** Template-specific payload. Validated by each template's own zod schema. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly orderId?: string;
}

export interface SendEmailResult {
  readonly providerMessageId: string;
}

export interface EmailPort {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/**
 * An append-only audit entry.
 *
 * Written in the SAME transaction as the change it describes, so a rolled-back
 * change cannot leave a phantom audit row. The runtime DB role holds INSERT and
 * SELECT only on this table — an audit log the application can UPDATE is not an
 * audit log.
 */
export const auditLogEntrySchema = z
  .object({
    id: idSchema,
    /** Null for system/cron actors. */
    actorId: idSchema.nullable(),
    actorRole: roleSchema.nullable(),
    action: z.string().max(80),
    entityType: z.string().max(64),
    entityId: z.string().max(64),
    /**
     * PII-REDACTED before/after diff. Redaction happens at write time, not at
     * read time: an unredacted value written once is leaked forever.
     */
    diff: z.record(
      z.string(),
      z.object({ before: z.unknown(), after: z.unknown() }).strict(),
    ),
    ipAddress: z.string().max(45).nullable(),
    userAgent: z.string().max(512).nullable(),
    requestId: z.string().max(64),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

/** One movement in the append-only inventory ledger. */
export const inventoryLedgerEntrySchema = z
  .object({
    id: idSchema,
    variantId: idSchema,
    movement: inventoryMovementSchema,
    /** Signed: negative for SALE and RESERVATION, positive for RESTOCK and RETURN. */
    quantityDelta: z.number().int(),
    /** Resulting on-hand, so the ledger is auditable without replaying from zero. */
    resultingOnHand: z.number().int().min(0),
    orderId: idSchema.nullable(),
    actorId: idSchema.nullable(),
    /** Mandatory on manual ADJUSTMENT — "someone changed it" is not an audit trail. */
    reason: z.string().max(500).nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type InventoryLedgerEntry = z.infer<typeof inventoryLedgerEntrySchema>;

/** Health probe payload. Readiness checks real dependencies, liveness does not. */
export const healthResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded", "error"]),
    version: z.string(),
    uptimeSeconds: z.number().min(0),
    checks: z.record(
      z.string(),
      z
        .object({
          status: z.enum(["up", "down"]),
          latencyMs: z.number().min(0).optional(),
          error: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
