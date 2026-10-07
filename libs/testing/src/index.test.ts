import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeEmailPort } from "./fake-email";
import {
  TEST_WOMPI_EVENTS_SECRET,
  buildForgedWompiEvent,
  buildSignedWompiEvent,
  wompiChecksum,
} from "./wompi-webhook";
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

describe("Wompi event signing", () => {
  const transaction = {
    id: "1234-1610641025-49201",
    status: "APPROVED",
    amount_in_cents: 4490000,
    reference: "AK-2026-000123-1",
    currency: "COP",
  };

  it("follows the documented manifest: values in order, then timestamp, then secret", () => {
    // docs.wompi.co "Eventos", steps 1-4, with our own secret.
    const expected = createHash("sha256")
      .update(`1234-1610641025-49201APPROVED44900001530291411${TEST_WOMPI_EVENTS_SECRET}`)
      .digest("hex");

    const signed = buildSignedWompiEvent(transaction, { timestamp: 1530291411 });

    expect(signed.signature.checksum).toBe(expected);
    expect(signed.signature.properties).toEqual([
      "transaction.id",
      "transaction.status",
      "transaction.amount_in_cents",
    ]);
  });

  it("is plain SHA-256 — the secret is hashed material, not an HMAC key", () => {
    expect(wompiChecksum({ a: { b: "x" } }, ["a.b"], 1, "s")).toBe(
      createHash("sha256").update("x1s").digest("hex"),
    );
  });

  it("produces a transaction.updated envelope stamped for sandbox", () => {
    const signed = buildSignedWompiEvent(transaction);

    expect(signed.event).toBe("transaction.updated");
    expect(signed.environment).toBe("test");
    expect(signed.data.transaction).toEqual(transaction);
  });

  it("signs a forged event with a different secret", () => {
    const genuine = buildSignedWompiEvent(transaction, { timestamp: 1 });
    const forged = { ...buildForgedWompiEvent(transaction), timestamp: 1 };

    expect(forged.signature.checksum).not.toBe(genuine.signature.checksum);
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
