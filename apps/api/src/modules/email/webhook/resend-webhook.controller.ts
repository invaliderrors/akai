import {
  BadRequestException,
  Controller,
  Inject,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import type { ServerEnv } from "@akai/config";

import { Public } from "../../../common/decorators/public.decorator";
import { SERVER_CONFIG } from "../../config/config.module";
import {
  RESEND_ID_HEADER,
  RESEND_SIGNATURE_HEADER,
  RESEND_TIMESTAMP_HEADER,
  verifyResendSignature,
} from "./resend-signature";
import { resendWebhookEnvelopeSchema } from "./resend-webhook.schemas";
import { ResendWebhookService } from "./resend-webhook.service";

/** The RAW request body, attached by the per-path middleware mounted in main.ts. */
export interface RawBodyRequest {
  readonly rawBody?: Buffer;
}

interface WebhookAck {
  readonly received: true;
  readonly outcome: string;
}

/**
 * `POST /v1/webhooks/resend` — delivery outcomes from the mail provider.
 *
 * `@Public()` because it authenticates by SIGNATURE, not by session: Resend has
 * no account here and presents no credential beyond the HMAC.
 *
 * IT ANSWERS 2xx FOR EVERYTHING IT UNDERSTOOD, including events it chooses to
 * ignore and events naming a message it cannot find. Resend retries on any
 * non-2xx, so returning an error for "not interesting" would earn an escalating
 * retry storm for a delivery we will never act on. Only two things are refused:
 * a body that is not authentic, and a body that is not parseable.
 */
@Controller("webhooks/resend")
export class ResendWebhookController {
  private readonly logger = new Logger(ResendWebhookController.name);

  constructor(
    private readonly service: ResendWebhookService,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handle(
    @Req() request: RawBodyRequest,
    @Headers(RESEND_ID_HEADER) id: string | undefined,
    @Headers(RESEND_TIMESTAMP_HEADER) timestamp: string | undefined,
    @Headers(RESEND_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<WebhookAck> {
    const secret = this.config.RESEND_WEBHOOK_SECRET;
    if (secret === undefined || secret === "") {
      // FAIL CLOSED AND LOUDLY. Accepting unverified deliveries would let anyone
      // mark any message as bounced; silently 200-ing them would make the log
      // look healthy while statuses never move. 503 also tells Resend to retry,
      // so events are not lost once the secret is configured.
      this.logger.error({}, "RESEND_WEBHOOK_SECRET is not configured — refusing the delivery");
      throw new ServiceUnavailableException({
        code: "WEBHOOK_NOT_CONFIGURED",
        message: "Resend webhooks are not configured on this deployment",
      });
    }

    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      // Distinguished from a bad signature DELIBERATELY: this means the raw-body
      // middleware is not mounted on this path, and it presents as "every
      // webhook 400s". A generic signature error would send the next person
      // debugging in precisely the wrong direction.
      this.logger.error({}, "Raw body unavailable — the middleware mount for this path is missing");
      throw new BadRequestException({
        code: "RAW_BODY_UNAVAILABLE",
        message: "Raw body unavailable",
      });
    }

    if (!verifyResendSignature(rawBody, { id, timestamp, signature }, secret, new Date())) {
      // One response for every rejection: wrong signature, missing header, stale
      // timestamp. Telling a forger WHICH check failed is a free oracle.
      this.logger.warn({ id }, "Rejected a Resend webhook with an invalid signature");
      throw new BadRequestException({
        code: "INVALID_SIGNATURE",
        message: "Signature verification failed",
      });
    }

    // Parsed only AFTER the signature holds, so unauthenticated input never
    // reaches the schema.
    const parsed = resendWebhookEnvelopeSchema.safeParse(safeJson(rawBody));
    if (!parsed.success) {
      this.logger.error({ id }, "Signature-verified Resend payload did not parse");
      throw new BadRequestException({
        code: "VALIDATION_FAILED",
        message: "Webhook payload was not understood",
      });
    }

    // `id` is defined here: verification refuses a missing one.
    const outcome = await this.service.apply(parsed.data, id ?? "");
    return { received: true, outcome: outcome.status };
  }
}

/** JSON.parse over a Buffer, as `unknown`, without throwing on malformed input. */
function safeJson(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    return null;
  }
}
