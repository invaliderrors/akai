import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { Public } from "../../../common/decorators/public.decorator";
import { SERVER_CONFIG } from "../../config/config.module";
import { LOGGER } from "../../observability/logger.module";
import { WompiSettlementService, type SettlementOutcome } from "../wompi-settlement.service";
import {
  TRANSACTION_UPDATED_EVENT,
  sanitiseRecord,
  verifyWompiEvent,
  wompiEventEnvelopeSchema,
  wompiTransactionSchema,
} from "../wompi/wompi-events";

/**
 * The route this controller answers on, WITHOUT the global API prefix.
 * Exported so `api-paths.ts` derives the full path from it rather than
 * retyping it.
 */
export const WOMPI_WEBHOOK_ROUTE = "webhooks/wompi";

export interface WebhookAck {
  readonly received: true;
  readonly outcome: SettlementOutcome["status"] | "unparsable" | "ignored";
}

@ApiTags("payments")
@Controller(WOMPI_WEBHOOK_ROUTE)
export class WompiWebhookController {
  constructor(
    private readonly settlement: WompiSettlementService,
    @Inject(SERVER_CONFIG) private readonly config: Pick<ServerEnv, "wompi">,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Wompi's event URL (`URL de Eventos` in the dashboard).
   *
   * `@Public()` because it authenticates by CHECKSUM, not by session. That makes
   * verification THE ENTIRE SECURITY BOUNDARY: without it anyone could POST an
   * APPROVED transaction and mark any order paid.
   *
   * VERIFICATION IS OURS, PARSING IS ZOD'S. The sequence, in this order:
   *
   *   0. keys configured        -> 503 (Wompi retries; never verify against "")
   *   1. envelope shape          -> 400 (cannot even present a checksum)
   *   2. checksum                -> 400 INVALID_SIGNATURE (logged, secret-free)
   *   3. environment / event     -> 200 ignored
   *   4. transaction zod parse   -> 200 unparsable (one deduped alert)
   *   5. settle, deduped on (transaction id, status), under the order lock
   *
   * NO RAW BODY. Wompi's checksum covers named fields of the PARSED body plus a
   * timestamp, never the bytes, so the JSON body parser is all this route needs.
   *
   * From step 3 on the answer is always 200 — including ignored, duplicate,
   * unmatched and unparsable events — because anything else makes Wompi retry
   * (30 min, 3 h, 24 h) something we will keep refusing. PENDING is acked here
   * too; the order is untouched.
   */
  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handle(
    @Body() body: unknown,
    @Headers("x-event-checksum") headerChecksum: string | undefined,
  ): Promise<WebhookAck> {
    // --- 0. Configured -----------------------------------------------------
    const wompi = this.config.wompi;
    if (wompi === null) {
      this.logger.error({}, "Wompi event received but no WOMPI_* keys are configured");
      throw new ServiceUnavailableException({
        code: "WEBHOOK_NOT_CONFIGURED",
        message: "Payments are not configured",
      });
    }

    // --- 1. Envelope --------------------------------------------------------
    // `sanitiseRecord` first: `JSON.parse` makes `__proto__` an own property.
    const raw = sanitiseRecord(body);
    const envelope = wompiEventEnvelopeSchema.safeParse({
      ...raw,
      data: sanitiseRecord(raw["data"]),
      signature: sanitiseRecord(raw["signature"]),
    });

    if (!envelope.success) {
      this.logger.warn(
        { issues: envelope.error.issues.map((issue) => issue.path.join(".")) },
        "Rejected a Wompi event without a verifiable envelope",
      );
      throw new BadRequestException({
        code: "INVALID_SIGNATURE",
        message: "Signature verification failed",
      });
    }

    const event = envelope.data;

    // --- 2. Checksum --------------------------------------------------------
    const verdict = verifyWompiEvent(event, wompi.eventsSecret, headerChecksum);
    if (!verdict.ok) {
      // Enough to tell a wrong secret from a wrong manifest from a forgery —
      // and nothing an attacker or a log reader could use: no secret, no full
      // digest. The response is generic.
      this.logger.warn(
        { ...verdict.diagnostics, event: event.event, environment: event.environment ?? null },
        "Rejected a Wompi event with a bad checksum",
      );
      throw new BadRequestException({
        code: "INVALID_SIGNATURE",
        message: "Signature verification failed",
      });
    }

    // --- 3. Environment and event type --------------------------------------
    if (event.environment !== undefined && event.environment !== wompi.eventEnvironment) {
      // Verified with OUR secret, yet stamped for the other environment — a
      // dashboard pointing sandbox events at production, say. Never settle it.
      this.logger.warn(
        { environment: event.environment, expected: wompi.eventEnvironment },
        "Wompi event for the other environment ignored",
      );
      return { received: true, outcome: "ignored" };
    }

    if (event.event !== TRANSACTION_UPDATED_EVENT) {
      this.logger.info({ event: event.event }, "Wompi event type not handled; acknowledged");
      return { received: true, outcome: "ignored" };
    }

    // --- 4. Transaction -----------------------------------------------------
    const transaction = wompiTransactionSchema.safeParse(sanitiseRecord(event.data["transaction"]));
    if (!transaction.success) {
      await this.settlement.recordUnparsable(
        event.signature.checksum,
        transaction.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      );
      return { received: true, outcome: "unparsable" };
    }

    // --- 5. Settle ----------------------------------------------------------
    const outcome = await this.settlement.applyTransaction(transaction.data, {
      source: "webhook",
      eventTime: eventTime(event.sent_at, event.timestamp),
    });

    return { received: true, outcome: outcome.status };
  }
}

/** `sent_at`, else the unix `timestamp`, as a Date. */
function eventTime(sentAt: string | undefined, timestamp: number): Date {
  if (sentAt !== undefined) {
    const parsed = new Date(sentAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(timestamp * 1000);
}
