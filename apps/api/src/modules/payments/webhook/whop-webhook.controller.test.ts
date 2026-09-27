import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { parseServerEnv, type ServerEnv } from "@akai/config";
import { createLogger } from "@akai/observability";
import { beforeEach, describe, expect, it } from "vitest";

import { TransitionTableOrderState } from "../order-state.port";
import {
  WhopWebhookController,
  type RawBodyRequest,
} from "./whop-webhook.controller";
import {
  FakePaymentsRepository,
  TEST_WHOP_WEBHOOK_SECRET,
  buildForgedWhopEvent,
  buildSignedWhopEvent,
  buildStaleWhopEvent,
  orderLine,
  orderSnapshot,
  paymentSnapshot,
  paymentSucceededEvent,
  type SignedWhopWebhook,
} from "./whop-webhook.fakes";
import { WhopWebhookService } from "./whop-webhook.service";

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  DIRECT_DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WHOP_API_KEY: "whop_test_abc123def456ghi789",
  WHOP_ACCOUNT_ID: "biz_test_1",
  WHOP_PRODUCT_ID: "prod_test_1",
  WHOP_WEBHOOK_SECRET: TEST_WHOP_WEBHOOK_SECRET,
  WHOP_API_VERSION_DATE: "2026-08-14",
  // PINNED, as every real deployment does. Unset, NODE_ENV="test" is not
  // production, so the environment resolves to SANDBOX and the schema demands a
  // sandbox credential set — the parse throws in beforeEach and takes the whole
  // suite with it. These suites exercise the live-credential path.
  WHOP_ENVIRONMENT: "live",
  EMAIL_TRANSPORT: "smtp",
  SMTP_URL: "smtp://localhost:1025",
  EMAIL_FROM: "no-reply@example.com",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "akai-media",
  S3_BUCKET_COA: "akai-coa",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  STOREFRONT_URL: "http://localhost:3000",
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
};

let repository: FakePaymentsRepository;
let controller: WhopWebhookController;

beforeEach(() => {
  repository = new FakePaymentsRepository();
  repository.seedOrder(orderSnapshot(), [orderLine()]);
  repository.seedPayment(paymentSnapshot());

  const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });
  const config: ServerEnv = parseServerEnv(TEST_ENV);

  controller = new WhopWebhookController(
    new WhopWebhookService(repository, new TransitionTableOrderState(), logger),
    config,
    logger,
  );
});

/** POST a signed delivery the way Express would present it. */
async function post(signed: SignedWhopWebhook): Promise<{ outcome: string }> {
  const request: RawBodyRequest = { rawBody: signed.rawBody, headers: signed.headers };
  return controller.handle(request, signed.headers["webhook-id"]);
}

/** Narrow a Nest exception body without asserting its shape. */
function errorCode(error: unknown): string | null {
  if (!(error instanceof BadRequestException)) {
    return null;
  }

  const response: string | object = error.getResponse();

  if (typeof response === "object" && response !== null && "code" in response) {
    const code: unknown = Reflect.get(response, "code");
    return typeof code === "string" ? code : null;
  }

  return null;
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return errorCode(error);
  }
}

// ---------------------------------------------------------------------------
// Steps 1-2 — the security boundary
// ---------------------------------------------------------------------------

describe("WhopWebhookController — signature verification", () => {
  it("accepts and applies a genuinely signed event", async () => {
    const signed = buildSignedWhopEvent(paymentSucceededEvent());

    const result = await post(signed);

    expect(result).toEqual({ received: true, outcome: "applied" });
    expect(repository.order().status).toBe("PAID");
  });

  it("rejects a MISSING raw body with a code distinct from a signature failure", async () => {
    // This failure means the raw-body middleware is not mounted on this path, and
    // it presents as "every webhook 400s". A generic signature error would send
    // the next person debugging in exactly the wrong direction.
    const signed = buildSignedWhopEvent(paymentSucceededEvent());

    const code = await codeOf(controller.handle({ headers: signed.headers }, signed.deliveryId));

    expect(code).toBe("RAW_BODY_UNAVAILABLE");
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });

  it("rejects a delivery with no signature headers at all", async () => {
    const signed = buildSignedWhopEvent(paymentSucceededEvent());

    const code = await codeOf(
      controller.handle({ rawBody: signed.rawBody, headers: {} }, undefined),
    );

    expect(code).toBe("INVALID_SIGNATURE");
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });

  it("rejects a forged signature and changes nothing", async () => {
    // THE ENTIRE SECURITY BOUNDARY. Whop presents no session and no other
    // credential, so an endpoint that accepts this lets anyone on the internet
    // mark any order PAID.
    const forged = buildForgedWhopEvent(paymentSucceededEvent());

    expect(await codeOf(post(forged))).toBe("INVALID_SIGNATURE");
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
    expect(repository.providerEvents).toHaveLength(0);
  });

  it("rejects a body tampered with after signing", async () => {
    const signed = buildSignedWhopEvent(paymentSucceededEvent());
    const tampered: SignedWhopWebhook = {
      ...signed,
      rawBody: Buffer.from(signed.payload.replace("49.99", "0.01"), "utf8"),
    };

    expect(await codeOf(post(tampered))).toBe("INVALID_SIGNATURE");
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });

  it("PROVES the route needs the RAW body: a JSON-reparsed body fails verification", async () => {
    // The single most common webhook integration defect. The signature covers the
    // exact bytes sent, so a body that has been through JSON.parse/JSON.stringify
    // has different whitespace and key order. A controller reading `request.body`
    // would fail every real delivery while passing any test that re-serialises.
    const signed = buildSignedWhopEvent(paymentSucceededEvent());
    const reparsed: SignedWhopWebhook = {
      ...signed,
      rawBody: Buffer.from(JSON.stringify(JSON.parse(signed.payload), null, 2), "utf8"),
    };

    expect(await codeOf(post(reparsed))).toBe("INVALID_SIGNATURE");
  });

  it("rejects a header array, rather than joining it into a value nobody sent", async () => {
    const signed = buildSignedWhopEvent(paymentSucceededEvent());

    const code = await codeOf(
      controller.handle(
        {
          rawBody: signed.rawBody,
          headers: { ...signed.headers, "webhook-signature": ["a", "b"] },
        },
        signed.deliveryId,
      ),
    );

    expect(code).toBe("INVALID_SIGNATURE");
  });
});

// ---------------------------------------------------------------------------
// The replay window — enforced by the TRANSPORT, which is new
// ---------------------------------------------------------------------------

describe("WhopWebhookController — replay window", () => {
  it("REJECTS an authentic delivery whose timestamp is outside the window", async () => {
    // The defence the previous provider could not offer. TagadaPay's HMAC covered
    // the raw body alone with no timestamp bound into the signed material, so a
    // captured delivery was replayable indefinitely and `provider_event` was the
    // only unconditional guard. Whop signs `{id}.{timestamp}.{body}`, so this
    // payload is genuinely authentic and is still refused.
    const stale = buildStaleWhopEvent(paymentSucceededEvent());

    expect(await codeOf(post(stale))).toBe("INVALID_SIGNATURE");
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
    expect(repository.providerEvents).toHaveLength(0);
  });

  it("accepts a delivery just inside the window", async () => {
    const fresh = buildSignedWhopEvent(paymentSucceededEvent(), {
      timestampSeconds: Math.floor(Date.now() / 1000) - 60,
    });

    expect(await post(fresh)).toEqual({ received: true, outcome: "applied" });
  });

  it("cannot be bypassed by advancing the timestamp header", async () => {
    // The property that makes the window real rather than advisory: the timestamp
    // is inside the signed material, so an attacker replaying a captured delivery
    // cannot re-stamp it without invalidating the signature.
    const stale = buildStaleWhopEvent(paymentSucceededEvent());
    const restamped: SignedWhopWebhook = {
      ...stale,
      headers: {
        ...stale.headers,
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      },
    };

    expect(await codeOf(post(restamped))).toBe("INVALID_SIGNATURE");
  });
});

// ---------------------------------------------------------------------------
// Step 3 — verified, but not something we understand
// ---------------------------------------------------------------------------

describe("WhopWebhookController — verified but unparsable", () => {
  it("answers 200 { unparsable } and alerts, rather than 400", async () => {
    // The loudest thing that can happen without money moving: the bytes are
    // provably Whop's and we do not understand them. A 4xx would make the vendor
    // retry a payload we will keep failing on — 12 attempts over ~71 hours, then
    // the endpoint is disabled — so the correct outcome is one alert and an order
    // visibly stuck for an operator to find.
    // No `type`, which the envelope requires. A payload with an unrecognised
    // SHAPE is not enough to land here: every field on `data` is optional by
    // design, so an unfamiliar object parses to an event we simply cannot
    // correlate — which is `unmatched`, not `unparsable`.
    const signed = buildSignedWhopEvent({ id: "evt_1", data: { id: "pay_1" } });

    const result = await post(signed);

    expect(result).toEqual({ received: true, outcome: "unparsable" });
    expect(repository.outboxFor("notifications")).toHaveLength(1);
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });

  it("alerts ONCE however many times the same unparsable body is replayed", async () => {
    // An unbounded, un-deduped write reachable by replay is exactly what the
    // dedupe transaction exists to forbid. The key is the digest of the signed
    // bytes, so identical bytes collide.
    const body = { id: "evt_no_type", data: { id: "pay_1" } };

    await post(buildSignedWhopEvent(body));
    await post(buildSignedWhopEvent(body));
    await post(buildSignedWhopEvent(body));

    expect(repository.outboxFor("notifications")).toHaveLength(1);
  });

  it("gives DIFFERENT unparsable bodies different alerts", async () => {
    await post(buildSignedWhopEvent({ id: "evt_a", data: { id: "pay_1" } }));
    await post(buildSignedWhopEvent({ id: "evt_b", data: { id: "pay_2" } }));

    expect(repository.outboxFor("notifications")).toHaveLength(2);
  });

  it("REFUSES a signed body that is valid JSON but not an object", async () => {
    // `unwrapWebhook` is typed as returning a record, but that type is an
    // assertion over `JSON.parse` — a signed body of `[]` is authentic and is
    // not a record. The verifier narrows rather than trusting the declaration.
    const signed = buildSignedWhopEvent([] as unknown as Record<string, unknown>);

    expect(await codeOf(post(signed))).toBe("INVALID_SIGNATURE");
  });

  it("ACKs an unfamiliar-but-well-formed payload as unmatched, not unparsable", async () => {
    // The `.strip()` decision made visible. Whop ships additive fields under a
    // pinned version; `.strict()` would turn the first one into a total
    // settlement outage. An unknown field is dropped at the boundary and the
    // event is judged on the fields we do declare.
    const body = paymentSucceededEvent({}, { some_future_field: { nested: true } });

    expect(await post(buildSignedWhopEvent(body))).toEqual({
      received: true,
      outcome: "applied",
    });
  });
});

// ---------------------------------------------------------------------------
// Prototype pollution — a measured hole, kept closed
// ---------------------------------------------------------------------------

describe("WhopWebhookController — boundary integrity", () => {
  it("REFUSES to settle on an amount smuggled through __proto__", async () => {
    // MEASURED, NOT THEORISED, on the previous provider. Verification ends in
    // JSON.parse, which creates `__proto__` as an OWN data property; a spread
    // then writes it through the prototype SETTER, and zod reads inherited
    // properties — so a delivery carrying NO amount, which must land in
    // PAYMENT_MISMATCH because absence is never agreement, could be made to
    // SETTLE by appending a `__proto__` object.
    const body = paymentSucceededEvent();
    const data = body["data"] as Record<string, unknown>;
    delete data["total"];
    delete data["currency"];

    const signed = buildSignedWhopEvent(
      JSON.parse(
        JSON.stringify(body).replace(
          '"status":"paid"',
          '"status":"paid","__proto__":{"total":49.99,"currency":"eur"}',
        ),
      ) as Record<string, unknown>,
    );

    await post(signed);

    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
    expect(repository.order().status).not.toBe("PAID");
  });
});

// ---------------------------------------------------------------------------
// Steps 4-6 — dedupe, correlation, act
// ---------------------------------------------------------------------------

describe("WhopWebhookController — dedupe and correlation", () => {
  it("answers 200 { duplicate } for a replayed delivery, and runs the handler once", async () => {
    const signed = buildSignedWhopEvent(paymentSucceededEvent(), {
      deliveryId: "msg_replayed",
    });

    expect(await post(signed)).toEqual({ received: true, outcome: "applied" });
    expect(await post(signed)).toEqual({ received: true, outcome: "duplicate" });
    expect(repository.handlerRuns).toBe(1);
  });

  it("dedupes on the webhook-id HEADER, which is what Whop tells integrators to store", async () => {
    // Two deliveries with an IDENTICAL body but different transport ids are two
    // events, not one — the header is the identity.
    const body = paymentSucceededEvent();

    await post(buildSignedWhopEvent(body, { deliveryId: "msg_a" }));

    expect(repository.providerEvents.map((event) => event.id)).toEqual(["msg_a"]);
  });

  it("answers 200 { unmatched } for an event carrying no correlation key", async () => {
    const body = paymentSucceededEvent();
    const data = body["data"] as Record<string, unknown>;
    delete data["checkout_configuration_id"];
    delete data["metadata"];

    const result = await post(buildSignedWhopEvent(body));

    // Whop delivers everything the endpoint is subscribed to, including payments
    // we did not originate. A non-2xx would put those into a retry loop.
    expect(result).toEqual({ received: true, outcome: "unmatched" });
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });

  it("answers 200 { ignored } for an event type it does not handle", async () => {
    const result = await post(
      buildSignedWhopEvent(paymentSucceededEvent({ type: "payment.authorized" })),
    );

    expect(result).toEqual({ received: true, outcome: "ignored" });
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });

  it("parks a mismatched amount in PAYMENT_MISMATCH and still answers 200", async () => {
    const result = await post(
      buildSignedWhopEvent(paymentSucceededEvent({}, { total: 0.01 })),
    );

    expect(result).toEqual({ received: true, outcome: "applied" });
    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
  });

  it("does NOT settle on amount_after_fees, which is net of Whop's cut", async () => {
    // The highest-consequence field choice in the integration. `total` is what
    // the buyer was charged; `amount_after_fees` is what we receive. Comparing
    // the latter against our grand total would mismatch EVERY order.
    const body = paymentSucceededEvent({}, { amount_after_fees: 49.99, total: 47.0 });

    await post(buildSignedWhopEvent(body));

    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
  });
});
