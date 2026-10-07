import { unwrapWebhook } from "@whop/sdk/helpers";
import { describe, expect, it } from "vitest";
import { FakeEmailPort } from "./fake-email";
import {
  TEST_WHOP_WEBHOOK_SECRET,
  buildForgedWhopEvent,
  buildSignedWhopEvent,
  buildStaleWhopEvent,
} from "./whop-webhook";
import { buildOrder, buildPrice } from "./builders";

describe("FakeEmailPort", () => {
  it("records sends and returns a provider id", async () => {
    const email = new FakeEmailPort();
    const result = await email.send({
      to: "ana@example.com",
      templateKey: "order-confirmation",
      locale: "es",
      data: {},
      orderId: "order-1",
    });

    expect(result.providerMessageId).toBe("fake-1");
    expect(email.messages).toHaveLength(1);
  });

  it("counts sends per (order, template) — the idempotency assertion", () => {
    const email = new FakeEmailPort();
    expect(email.countFor("order-1", "order-confirmation")).toBe(0);
  });

  it("can fail once, so retry and DLQ paths are testable", async () => {
    const email = new FakeEmailPort();
    email.failOnce();

    await expect(
      email.send({ to: "a@b.com", templateKey: "verify-email", locale: "es", data: {} }),
    ).rejects.toThrow();

    // The next send succeeds — the failure is armed once, not sticky.
    await email.send({
      to: "a@b.com",
      templateKey: "verify-email",
      locale: "es",
      data: {},
    });
    expect(email.messages).toHaveLength(1);
  });
});

describe("Whop webhook signing", () => {
  /**
   * Verified against `unwrapWebhook` — THE ACTUAL PRODUCTION VERIFIER.
   *
   * The TagadaPay version of this suite checked the builder against an
   * independent reimplementation of the algorithm, because production's verifier
   * was also ours and checking one against the other would only have proved both
   * were deterministic. Here the verifier is the vendor's, so asserting directly
   * against it is strictly stronger: it proves these bytes are bytes the shipped
   * code accepts, including the `ws_` base64 handling that is easy to get wrong
   * in a way no reimplementation would catch.
   */
  function verify(signed: { payload: string; headers: Record<string, string> }): unknown {
    return unwrapWebhook(signed.payload, {
      headers: signed.headers,
      key: TEST_WHOP_WEBHOOK_SECRET,
    });
  }

  it("produces a delivery the real verifier accepts", () => {
    const signed = buildSignedWhopEvent({
      id: "msg_1",
      type: "payment.succeeded",
      data: { id: "pay_1", total: 49.99, currency: "eur" },
    });

    expect(verify(signed)).toMatchObject({ type: "payment.succeeded" });
  });

  it("emits all three Standard Webhooks headers", () => {
    const { headers, deliveryId } = buildSignedWhopEvent({ type: "payment.succeeded" });

    expect(headers["webhook-id"]).toBe(deliveryId);
    expect(headers["webhook-signature"]).toMatch(/^v1,/);
    expect(Number(headers["webhook-timestamp"])).toBeGreaterThan(0);
  });

  it("REJECTS a signature computed with the wrong secret", () => {
    // The whole security boundary: Whop presents no session and no other
    // credential, so an endpoint that accepts this lets anyone mark orders paid.
    const forged = buildForgedWhopEvent({ type: "payment.succeeded" });

    expect(() => verify(forged)).toThrow();
  });

  it("REJECTS a tampered body under an authentic signature", () => {
    const signed = buildSignedWhopEvent({
      type: "payment.succeeded",
      data: { total: 49.99 },
    });

    const tampered = { ...signed, payload: signed.payload.replace("49.99", "0.01") };

    expect(() => verify(tampered)).toThrow();
  });

  it("REJECTS a re-serialised body — the single most common integration defect", () => {
    // The signature covers the exact bytes sent. A body that has been through
    // JSON.parse/JSON.stringify has different whitespace and key order, so a
    // controller that reads `request.body` instead of the raw buffer fails every
    // real delivery while passing any test that re-serialises.
    const signed = buildSignedWhopEvent({ type: "payment.succeeded", data: { id: "pay_1" } });
    const reSerialised = JSON.stringify(JSON.parse(signed.payload), null, 2);

    expect(() => verify({ ...signed, payload: reSerialised })).toThrow();
  });

  it("REJECTS an authentic delivery outside the replay window", () => {
    // A test the TagadaPay scheme could not support at all: its HMAC covered the
    // raw body alone, so the transport had no notion of when a delivery
    // happened. Here the timestamp is inside the signed material, so this
    // payload is genuinely authentic and must still be refused.
    const stale = buildStaleWhopEvent({ type: "payment.succeeded" });

    expect(() => verify(stale)).toThrow();
  });

  it("repeats the delivery id on demand, so redelivery is testable", () => {
    const first = buildSignedWhopEvent({ type: "payment.succeeded" }, { deliveryId: "msg_fixed" });
    const second = buildSignedWhopEvent({ type: "payment.succeeded" }, { deliveryId: "msg_fixed" });

    expect(second.deliveryId).toBe(first.deliveryId);
  });
});

describe("builders", () => {
  it("produces an order whose money components are internally consistent", () => {
    const order = buildOrder();
    expect(order["subtotal"]).toBe(7_478_992);
    expect(order["taxTotal"]).toBe(1_421_008);
    expect(order["grandTotal"]).toBe(8_900_000);
    // The invariant every order must satisfy.
    const subtotal = order["subtotal"] as number;
    const tax = order["taxTotal"] as number;
    expect(subtotal + tax).toBe(order["grandTotal"]);
  });

  it("lets a test state only the field it is about", () => {
    const order = buildOrder({ status: "PAID" });
    expect(order["status"]).toBe("PAID");
    expect(order["orderNumber"]).toBe("AK-2026-000123");
  });

  it("builds a price where net + tax === gross", () => {
    const price = buildPrice();
    expect((price["net"] as number) + (price["tax"] as number)).toBe(price["gross"]);
  });
});
