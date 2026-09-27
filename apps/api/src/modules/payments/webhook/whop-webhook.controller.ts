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
import { ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { Public } from "../../../common/decorators/public.decorator";
import { SERVER_CONFIG } from "../../config/config.module";
import { LOGGER } from "../../observability/logger.module";
import {
  KNOWN_PAYLOAD_KEYS,
  sanitiseRecord,
  whopEventEnvelopeSchema,
} from "./whop-webhook.schemas";
import { WhopWebhookService, type WebhookOutcome } from "./whop-webhook.service";
import { verifyWhopWebhook } from "./whop-webhook.verify";

/**
 * The RAW request body, as attached by the path-scoped raw-body middleware.
 *
 * Declared structurally rather than importing Express's `Request` type: these
 * are the only properties the handler touches, and depending on the whole
 * framework request type here would couple the payments module to the HTTP
 * adapter.
 */
export interface RawBodyRequest {
  readonly rawBody?: Buffer;
  readonly headers?: Record<string, unknown>;
}

export interface WebhookAck {
  readonly received: true;
  readonly outcome: WebhookOutcome["status"];
}

/**
 * Payload keys we have already warned about, so an additive vendor field
 * produces one log line per process rather than one per delivery.
 *
 * This is what buys back the visibility `.strict()` would have given on the
 * payload — see the recorded deviation in `whop-webhook.schemas.ts`.
 */
const warnedUnknownKeys = new Set<string>();

/**
 * The route this controller answers on, WITHOUT the global API prefix.
 *
 * Exported because `main.ts` must mount the raw-body middleware on exactly this
 * path and nothing else. Two independently-written string literals that have to
 * agree is the kind of coupling that fails silently — the middleware simply
 * never runs, the controller still gets the request, and every delivery 400s
 * with RAW_BODY_UNAVAILABLE. One constant, referenced twice.
 */
export const WHOP_WEBHOOK_ROUTE = "webhooks/whop";

/**
 * SHA-256 hex of the raw body — the dedupe identity of a body we could not parse.
 *
 * Computed ONLY after the signature has verified, so the value is derived from
 * bytes that are provably Whop's. It is not a secret and is safe to log: it is a
 * digest of a payload we already refused to act on.
 */
function digestOf(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

/**
 * The three Standard Webhooks headers, lower-cased and string-valued.
 *
 * Express types headers as `string | string[] | undefined`; an array means the
 * header arrived more than once. That is dropped rather than joined: joining
 * would invent a value the sender never sent, and a duplicated signature header
 * is not something a legitimate delivery does.
 */
function signatureHeaders(raw: Record<string, unknown> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
    const value = raw?.[name];
    if (typeof value === "string") {
      headers[name] = value;
    }
  }

  return headers;
}

@ApiTags("payments")
@Controller(WHOP_WEBHOOK_ROUTE)
export class WhopWebhookController {
  constructor(
    private readonly webhooks: WhopWebhookService,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The Whop webhook endpoint.
   *
   * `@Public()` because it authenticates by SIGNATURE, not by session — Whop has
   * no cookie. That makes signature verification THE ENTIRE SECURITY BOUNDARY:
   * without it, anyone on the internet could POST `payment.succeeded` and mark
   * any order paid. Hence the forged-signature and tampered-body tests.
   *
   * The sequence, in this exact order, and the order is not negotiable:
   *
   *   1. raw body present      -> 400 RAW_BODY_UNAVAILABLE
   *   2. verify (signature AND timestamp window)
   *                            -> 400 INVALID_SIGNATURE
   *   3. zod safeParse         -> 200 { unparsable }   (never a 400 — see below)
   *   4. dedupe inside the state transaction
   *   5. correlate
   *   6. act
   *
   * THREE STEPS OF THE TAGADAPAY SEQUENCE ARE GONE, all absorbed by step 2: the
   * `sha256=` prefix check, the hand-rolled HMAC comparison, and a conditional
   * body-timestamp replay window that could not be enforced at all when a
   * delivery carried no timestamp. Whop binds `webhook-timestamp` into the
   * signed material with a five-minute tolerance, so that hole is closed by the
   * transport rather than papered over by us.
   *
   * Step 3 IS ITSELF DEDUPED, which is easy to miss because it precedes step 4.
   * Its one side effect — the operator alert — runs through `runOnceForEvent`
   * keyed on the digest of the signed bytes, so an unparsable delivery replayed
   * a thousand times produces one alert. Nothing on this route may write outside
   * a dedupe transaction; that is the whole property step 4 is claiming.
   *
   * Steps 1-2 are the security boundary. Steps 3-6 run only on bytes whose
   * authenticity is already established.
   *
   * From step 3 onward the answer is always 200, including for events we ignore,
   * have already seen, cannot correlate or cannot parse. A non-2xx makes Whop
   * retry — 12 attempts over ~71 hours, and an endpoint failing for 72 hours is
   * disabled outright — and retrying something we will keep refusing is a retry
   * storm, not a recovery.
   */
  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handle(
    @Req() request: RawBodyRequest,
    @Headers("webhook-id") deliveryId: string | undefined,
  ): Promise<WebhookAck> {
    // --- 1. Raw body ------------------------------------------------------
    const rawBody = request.rawBody;

    if (!Buffer.isBuffer(rawBody)) {
      // Distinguished from a bad signature DELIBERATELY. This particular failure
      // means the raw-body middleware is not mounted on this path, and it
      // presents as "every webhook 400s" — the single most common webhook
      // integration defect. A generic signature error would send the next person
      // debugging in exactly the wrong direction.
      this.logger.error(
        {},
        "Raw body unavailable — the raw-body middleware must be mounted on WHOP_WEBHOOK_PATH",
      );
      throw new BadRequestException({
        code: "RAW_BODY_UNAVAILABLE",
        message: "Request body was not available in raw form",
      });
    }

    // --- 2. Signature and timestamp window --------------------------------
    const verified = verifyWhopWebhook(
      rawBody,
      signatureHeaders(request.headers),
      // The ACTIVE environment's secret. Sandbox and live are separate Whop
      // accounts with separate signing secrets, so verifying with the wrong one
      // rejects every genuine delivery.
      this.config.whop.webhookSecret,
    );

    if (!verified.ok) {
      // The reason is logged; the response is generic, so an attacker probing
      // signatures learns nothing from it — including whether they failed on the
      // signature or on the replay window.
      this.logger.warn({ reason: verified.reason }, "Rejected an unverified Whop webhook");
      throw new BadRequestException({
        code: "INVALID_SIGNATURE",
        message: "Signature verification failed",
      });
    }

    // `sanitiseRecord` before zod: verification ends in `JSON.parse`, which
    // creates `__proto__` as an own data property. See FORBIDDEN_KEYS.
    const body = sanitiseRecord(verified.body);
    const payload = sanitiseRecord(body["data"]);
    const parsed = whopEventEnvelopeSchema.safeParse({
      ...body,
      data: { ...payload, metadata: sanitiseRecord(payload["metadata"]) },
    });

    // --- 3. Schema --------------------------------------------------------
    if (!parsed.success) {
      // NEVER a 400, and never an unbounded write either: the digest of the exact
      // signed bytes is what makes the alert idempotent under replay.
      await this.webhooks.recordUnparsable(
        digestOf(rawBody),
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      );
      return { received: true, outcome: "unparsable" };
    }

    this.logUnknownPayloadKeys(payload);

    // --- 4 + 5 + 6. Dedupe inside the state transaction, then act ---------
    //
    // THE DEDUPE KEY IS THE `webhook-id` HEADER, not the envelope's own `id`.
    // Whop's documentation names that header as the value to store to identify
    // duplicate deliveries, it is covered by the signature, and it is present on
    // every delivery — whereas the envelope id is a body field the schema has to
    // treat as optional. The digest of the signed bytes is the fallback, which
    // cannot collide across genuinely different deliveries.
    const outcome = await this.webhooks.handleEvent(
      parsed.data,
      deliveryId ?? `body:${digestOf(rawBody)}`,
    );

    this.logger.info(
      { eventType: parsed.data.type, outcome: outcome.status },
      "Whop webhook processed",
    );

    return { received: true, outcome: outcome.status };
  }

  /**
   * Warn once per process per payload key the schema does not declare.
   *
   * The payload is `.strip()`, not `.strict()` — the one recorded exception to
   * the "validate every external input" rule, argued in full in
   * `whop-webhook.schemas.ts`. This is the compensating control: an additive
   * vendor field is visible in the logs within minutes and breaks nothing,
   * instead of rejecting every payment notification the day Whop adds a field.
   */
  private logUnknownPayloadKeys(payload: Record<string, unknown>): void {
    for (const key of Object.keys(payload)) {
      if (KNOWN_PAYLOAD_KEYS.includes(key) || warnedUnknownKeys.has(key)) {
        continue;
      }

      warnedUnknownKeys.add(key);

      this.logger.warn(
        { key },
        "Whop webhook carried an undeclared payload key; it was dropped at the boundary",
      );
    }
  }
}
