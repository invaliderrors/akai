import { createHash } from "node:crypto";

import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
} from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { SENDCLOUD_WEBHOOK_ROUTE } from "../../../common/api-paths";
import { Public } from "../../../common/decorators/public.decorator";
import { SERVER_CONFIG } from "../../config/config.module";
import { LOGGER } from "../../observability/logger.module";
import { FulfilmentError } from "../fulfilment.errors";
import { SENDCLOUD_SIGNATURE_HEADER, verifySendcloudSignature } from "./sendcloud-signature";
import {
  SENDCLOUD_PARCEL_STATUS_CHANGED,
  sendcloudWebhookSchema,
} from "./sendcloud-webhook.schemas";
import { SendcloudWebhookService } from "./sendcloud-webhook.service";

/** The RAW request body, attached by the per-path middleware mounted in main.ts. */
export interface RawBodyRequest {
  readonly rawBody?: Buffer;
}

export interface SendcloudWebhookAck {
  readonly received: true;
  readonly outcome: "enqueued" | "duplicate" | "unmatched" | "ignored";
}

/**
 * `POST /v1/webhooks/sendcloud` — Sendcloud's "parcel status changed" hook
 * (spec 2026-09-24-sendcloud-shipping §3.7). Panel setup: Settings →
 * Integrations → the "Sendcloud API" integration → Webhook URL
 * `https://api.akai.shop/v1/webhooks/sendcloud`, webhooks ON; the Webhook
 * Signature Key (if one is set) goes into SENDCLOUD_WEBHOOK_SECRET.
 *
 * `@Public()` because it authenticates by SIGNATURE, not by session.
 *
 * Three refusals, all non-2xx so Sendcloud retries:
 *  - Sendcloud not configured on this deployment → the foundation's coded
 *    FULFILMENT_NOT_CONFIGURED (409 + reason, see `FulfilmentError`), never a
 *    silent 200 that would make a misconfigured deployment look healthy;
 *  - the raw body is missing (a middleware mount bug, named as such);
 *  - the signature does not verify.
 *
 * EVERYTHING ELSE IS 200 once the signature holds — an unparsable body, an
 * action we do not act on, a parcel we do not know, a duplicate. None of those
 * becomes actionable by retrying, and a non-2xx would buy ten retries each.
 */
@Controller(SENDCLOUD_WEBHOOK_ROUTE)
export class SendcloudWebhookController {
  constructor(
    private readonly service: SendcloudWebhookService,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handle(
    @Req() request: RawBodyRequest,
    @Headers(SENDCLOUD_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<SendcloudWebhookAck> {
    const sendcloud = this.config.sendcloud;
    if (sendcloud === null) {
      this.logger.error({}, "Sendcloud is not configured — refusing the webhook delivery");
      throw FulfilmentError.from("FULFILMENT_NOT_CONFIGURED");
    }

    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      // Distinguished from a bad signature DELIBERATELY: this is the raw-body
      // middleware not being mounted on this path, and it presents as "every
      // webhook fails".
      this.logger.error({}, "Raw body unavailable — the middleware mount for this path is missing");
      throw new BadRequestException({ code: "RAW_BODY_UNAVAILABLE", message: "Raw body unavailable" });
    }

    if (!verifySendcloudSignature(rawBody, signature, sendcloud.webhookSecret)) {
      // One answer for a missing, malformed and wrong signature: telling a
      // forger which check failed is a free oracle.
      this.logger.warn({}, "Rejected a Sendcloud webhook with an invalid signature");
      throw new BadRequestException({
        code: "INVALID_SIGNATURE",
        message: "Signature verification failed",
      });
    }

    // Parsed only AFTER the signature holds, so unauthenticated input never
    // reaches the schema.
    const parsed = sendcloudWebhookSchema.safeParse(safeJson(rawBody));
    if (!parsed.success) {
      this.logger.error(
        { issues: parsed.error.issues.map((issue) => issue.message) },
        "Signature-verified Sendcloud webhook did not parse — ignored",
      );
      return { received: true, outcome: "ignored" };
    }

    const { action, timestamp, parcel } = parsed.data;
    if (action !== SENDCLOUD_PARCEL_STATUS_CHANGED || parcel === undefined) {
      // Sendcloud also posts integration events (connect, test pings) here.
      this.logger.info({ action }, "Sendcloud webhook action not acted on");
      return { received: true, outcome: "ignored" };
    }

    // Spec §3.7: `sendcloud:{parcelId}:{timestamp}`. With no timestamp the body
    // digest stands in, so an exact redelivery still dedupes and a genuinely
    // different body still gets through.
    const discriminator =
      timestamp ?? `sha256:${createHash("sha256").update(rawBody).digest("hex").slice(0, 40)}`;
    const outcome = await this.service.accept({
      parcelId: parcel.id,
      eventId: `sendcloud:${parcel.id.toString()}:${discriminator}`,
      action,
    });

    return { received: true, outcome: outcome.status };
  }
}

/** JSON.parse over a Buffer, as `unknown`, without throwing on malformed input. */
function safeJson(rawBody: Buffer): unknown {
  try {
    const value: unknown = JSON.parse(rawBody.toString("utf8"));
    return value;
  } catch {
    return null;
  }
}
