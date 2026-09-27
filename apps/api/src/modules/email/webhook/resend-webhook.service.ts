import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { EmailStatus } from "@akai/contracts";

import { PrismaService } from "../../prisma/prisma.service";
import {
  RESEND_STATUS_BY_EVENT,
  describeOutcome,
  isStatusEvent,
  type ResendWebhookEnvelope,
} from "./resend-webhook.schemas";

/**
 * Applies a verified Resend delivery event to the email log.
 *
 * WHY THIS EXISTS: `email_event.status` only ever reached SENT or FAILED, because
 * those are the two outcomes the SEND path can observe. DELIVERED, BOUNCED and
 * COMPLAINED were declared in the enum and never written by anything — the
 * provider is the only party that knows them, and it reports them out of band.
 */

export type ResendWebhookOutcome =
  | { readonly status: "applied"; readonly emailStatus: EmailStatus }
  | { readonly status: "duplicate" }
  | { readonly status: "ignored"; readonly type: string }
  | { readonly status: "unmatched" }
  | { readonly status: "stale"; readonly current: EmailStatus };

/**
 * How far along the delivery a status is. A transition is applied only when it
 * moves FORWARD, because provider events arrive out of order and a late
 * `email.sent` must not undo a `email.delivered` that already landed.
 *
 * COMPLAINED outranks DELIVERED deliberately: a spam complaint happens AFTER a
 * successful delivery, and it is the more important fact — it costs sending
 * reputation for every other customer. FAILED shares SENT's rank because it is
 * our own send erroring before the provider ever saw the message; in practice a
 * FAILED row has no `providerMessageId`, so no webhook can correlate to it.
 */
const STATUS_RANK: Readonly<Record<EmailStatus, number>> = {
  QUEUED: 0,
  SENT: 1,
  FAILED: 1,
  DELIVERED: 2,
  BOUNCED: 3,
  COMPLAINED: 4,
};

/** `email_suppression.reason` is VarChar(64); truncate before the driver rejects it. */
const MAX_SUPPRESSION_REASON_LENGTH = 64;

/**
 * Whether this outcome should permanently stop customer mail to the address,
 * and the operator-facing reason to record if so.
 *
 * HARD VERSUS SOFT IS THE WHOLE POINT. Resend reports SES's bounce taxonomy in
 * `data.bounce.type`: `Permanent` is a mailbox that does not exist, `Transient`
 * is a temporary condition (over quota, throttled, greylisted) that clears on
 * its own, and `Undetermined` means the remote server said something the
 * provider could not classify. Only `Permanent` suppresses.
 *
 * Everything else — Transient, Undetermined, and a bounce carrying no `bounce`
 * object at all — deliberately does NOT. Suppression is not a queue we retry
 * later; it silently blackholes every future order confirmation until an
 * operator lifts it by hand. Paying that price on a full mailbox, or on a
 * bounce the provider itself could not classify, is worse than one more
 * delivery attempt to an address that may well be fine. The event is still
 * recorded as BOUNCED either way, so an operator can see the pattern at
 * /admin/email and lift or add nothing on the evidence.
 *
 * A complaint needs no classification: the recipient pressed "this is spam",
 * and that is the single most expensive signal a sending domain can accumulate.
 */
function suppressionReason(envelope: ResendWebhookEnvelope): string | null {
  if (envelope.type === "email.complained") {
    return "Spam complaint reported by the recipient";
  }
  if (envelope.type !== "email.bounced") {
    return null;
  }

  const bounce = envelope.data.bounce;
  if (bounce?.type?.toLowerCase() !== "permanent") {
    return null;
  }

  const detail = bounce.subType === undefined || bounce.subType === "" ? "" : ` (${bounce.subType})`;
  return `Hard bounce${detail}`.slice(0, MAX_SUPPRESSION_REASON_LENGTH);
}

/**
 * Only `$transaction` is used, and narrowing to it is what lets an integration
 * test hand this a plain container-backed client instead of the Nest-managed
 * `PrismaService`. The `@Inject` token is still the class, so DI is unchanged —
 * Nest resolves by token, not by the declared parameter type.
 */
type ResendPrismaClient = Pick<PrismaService, "$transaction">;

@Injectable()
export class ResendWebhookService {
  private readonly logger = new Logger(ResendWebhookService.name);

  constructor(@Inject(PrismaService) private readonly prisma: ResendPrismaClient) {}

  /**
   * `eventId` is the `svix-id` header — the provider's own id for this delivery,
   * and what makes a retry idempotent. Resend retries on any non-2xx, so without
   * dedupe a slow handler would apply the same bounce repeatedly.
   */
  async apply(envelope: ResendWebhookEnvelope, eventId: string): Promise<ResendWebhookOutcome> {
    if (!isStatusEvent(envelope.type)) {
      // Recognised-but-uninteresting (opens, clicks, delays) and genuinely
      // unknown types both land here. Neither is an error: returning 2xx is what
      // stops Resend retrying an event we will never act on.
      return { status: "ignored", type: envelope.type };
    }

    const nextStatus: EmailStatus = RESEND_STATUS_BY_EVENT[envelope.type];
    const providerMessageId = envelope.data.email_id;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // The dedupe INSERT and the status change share ONE transaction, so a
        // concurrent redelivery cannot both pass the check and both apply.
        // Scoped to this statement only: a P2002 from the update below would be
        // a real error and must not be reported as "already processed".
        await tx.providerEvent.create({
          data: {
            id: `resend:${eventId}`.slice(0, 128),
            type: envelope.type,
          },
        });

        const event = await tx.emailEvent.findFirst({
          where: { providerMessageId },
          select: { id: true, status: true, recipient: true },
        });

        if (event === null) {
          // Nothing to update, but the provider_event row above still commits,
          // so a retry of the same delivery is not reprocessed. This is normal
          // for mail sent by a different environment sharing one Resend account.
          this.logger.warn(
            { providerMessageId, type: envelope.type },
            "Resend event for an unknown message id",
          );
          return { status: "unmatched" } as const;
        }

        // SUPPRESSION, and it is written BEFORE the monotonic guard below.
        //
        // The guard is about `email_event.status`, which only ever moves
        // forward. Suppression is about the ADDRESS, and a hard bounce is
        // evidence the mailbox is dead whether or not the status column has
        // anywhere left to move — a bounce arriving after a complaint is
        // "stale" as a transition and still perfectly good evidence. Ordering
        // it after the guard would drop exactly that case on the floor.
        //
        // In the SAME transaction as the status change, deliberately: an event
        // recorded as BOUNCED with no suppression row is the defect this fixes,
        // and two statements that must both hold belong in one commit.
        //
        // `createMany` + `skipDuplicates` rather than `create` or `upsert`:
        // `email` is the PRIMARY KEY, so a repeat bounce for an address already
        // suppressed would raise P2002 — which this method's catch maps to
        // "duplicate", quietly reporting a failed write as successful dedupe.
        // This compiles to INSERT ... ON CONFLICT DO NOTHING, so it is
        // idempotent in the database rather than in a race window, and it keeps
        // the ORIGINAL reason and `createdAt`: when the address was first known
        // bad is the fact worth keeping.
        const reason = suppressionReason(envelope);
        if (reason !== null) {
          await tx.emailSuppression.createMany({
            data: [{ email: event.recipient, reason }],
            skipDuplicates: true,
          });
        }

        const current = event.status;
        if (STATUS_RANK[nextStatus] <= STATUS_RANK[current]) {
          return { status: "stale", current } as const;
        }

        const error = describeOutcome(envelope);
        await tx.emailEvent.update({
          where: { id: event.id },
          data: {
            status: nextStatus,
            // Only ever SET, never cleared: a DELIVERED event carries no error,
            // and blanking the column would erase the reason for an earlier
            // failure that is still worth reading.
            ...(error === null ? {} : { error }),
          },
        });

        return { status: "applied", emailStatus: nextStatus } as const;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { status: "duplicate" };
      }
      throw error;
    }
  }
}
