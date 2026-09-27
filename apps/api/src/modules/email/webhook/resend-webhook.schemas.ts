import { z } from "zod";
import type { EmailStatus } from "@akai/contracts";

/**
 * The Resend webhook envelope, validated at the boundary.
 *
 * `.strict()` is deliberately NOT used here, unlike request DTOs. This is a
 * third-party payload we do not control: Resend adds fields to it without asking,
 * and a strict schema would turn every such addition into a rejected delivery —
 * a bounce we never record because the envelope carrying it failed validation.
 * We validate the fields we READ and ignore the rest.
 */

/**
 * Event types that MOVE the status, mapped to what they move it to.
 *
 * `email.sent` is present but maps to SENT, which the send path already wrote —
 * it is here so the type is recognised rather than logged as unknown.
 *
 * `email.opened` and `email.clicked` are deliberately ABSENT. They are engagement
 * signals, not delivery outcomes, and folding them into `status` would overwrite
 * DELIVERED with something that says less. `email.delivery_delayed` is absent for
 * a different reason: it is transient, and a delayed message still ends in
 * delivered or bounced — recording it would flip a row to a scary state that
 * resolves itself.
 */
export const RESEND_STATUS_BY_EVENT = {
  "email.sent": "SENT",
  "email.delivered": "DELIVERED",
  "email.bounced": "BOUNCED",
  "email.complained": "COMPLAINED",
} as const satisfies Record<string, EmailStatus>;

export type ResendStatusEvent = keyof typeof RESEND_STATUS_BY_EVENT;

export function isStatusEvent(type: string): type is ResendStatusEvent {
  return Object.hasOwn(RESEND_STATUS_BY_EVENT, type);
}

export const resendWebhookEnvelopeSchema = z.object({
  type: z.string().min(1).max(64),
  /** Provider-side send time. Not trusted for ordering — see the service. */
  created_at: z.string().max(64).optional(),
  data: z.object({
    /**
     * Resend's id for the message, and the ONLY thing that ties this event to a
     * row: it is what `EmailEvent.providerMessageId` stores when the send
     * succeeds.
     */
    email_id: z.string().min(1).max(200),
    to: z.array(z.string()).optional(),
    subject: z.string().optional(),
    /** Present on bounces. Free-form provider prose, stored for an operator. */
    bounce: z
      .object({
        type: z.string().max(64).optional(),
        subType: z.string().max(64).optional(),
        message: z.string().max(1000).optional(),
      })
      .optional(),
  }),
});

export type ResendWebhookEnvelope = z.infer<typeof resendWebhookEnvelopeSchema>;

/**
 * A short operator-facing reason for a bounce or complaint.
 *
 * Truncated to the column width. Returns null when the provider said nothing
 * useful, so a successful delivery never leaves stale error text behind.
 */
export function describeOutcome(envelope: ResendWebhookEnvelope): string | null {
  if (envelope.type === "email.complained") {
    return "Recipient marked the message as spam";
  }
  if (envelope.type !== "email.bounced") {
    return null;
  }

  const bounce = envelope.data.bounce;
  if (bounce === undefined) {
    return "Bounced (no detail supplied)";
  }

  const parts = [bounce.type, bounce.subType, bounce.message].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return parts.length === 0 ? "Bounced (no detail supplied)" : parts.join(" · ").slice(0, 1000);
}
