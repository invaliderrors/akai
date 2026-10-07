import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildWompiManifest,
  computeWompiChecksum,
  sanitiseRecord,
  verifyWompiEvent,
  wompiEventEnvelopeSchema,
  wompiTransactionSchema,
  type WompiEventEnvelope,
} from "./wompi-events";

const SECRET = "test_events_unit_secret";

/** Wompi's documented example event, with the checksum left to each test. */
function docEvent(checksum = "0".repeat(64)): WompiEventEnvelope {
  return {
    event: "transaction.updated",
    data: {
      transaction: {
        id: "1234-1610641025-49201",
        amount_in_cents: 4490000,
        reference: "MZQ3X2DE2SMX",
        customer_email: "juan.perez@gmail.com",
        currency: "COP",
        payment_method_type: "NEQUI",
        redirect_url: "https://mitienda.com.co/pagos/redireccion",
        status: "APPROVED",
        shipping_address: null,
        payment_link_id: null,
        payment_source_id: null,
      },
    },
    environment: "prod",
    signature: {
      properties: ["transaction.id", "transaction.status", "transaction.amount_in_cents"],
      checksum,
    },
    timestamp: 1530291411,
    sent_at: "2018-07-20T16:45:05.000Z",
  };
}

/** The documented algorithm, written out independently of the implementation. */
function expectedChecksum(secret: string): string {
  return createHash("sha256")
    .update(`1234-1610641025-49201APPROVED44900001530291411${secret}`)
    .digest("hex");
}

describe("buildWompiManifest", () => {
  it("concatenates the named values in order, then the timestamp (docs' worked steps)", () => {
    expect(buildWompiManifest(docEvent())).toBe(
      "1234-1610641025-49201APPROVED44900001530291411",
    );
  });

  it("accepts properties written with a leading data. segment", () => {
    const event = docEvent();
    const prefixed: WompiEventEnvelope = {
      ...event,
      signature: {
        ...event.signature,
        properties: event.signature.properties.map((path) => `data.${path}`),
      },
    };
    expect(buildWompiManifest(prefixed)).toBe(buildWompiManifest(event));
  });

  it("contributes nothing for an absent or null property instead of throwing", () => {
    const event = docEvent();
    const odd: WompiEventEnvelope = {
      ...event,
      signature: { ...event.signature, properties: ["transaction.nope", "transaction.shipping_address"] },
    };
    expect(buildWompiManifest(odd)).toBe("1530291411");
  });

  it("never walks into the prototype chain", () => {
    const event = docEvent();
    const probing: WompiEventEnvelope = {
      ...event,
      signature: { ...event.signature, properties: ["transaction.constructor.name", "toString"] },
    };
    expect(buildWompiManifest(probing)).toBe("1530291411");
  });
});

describe("computeWompiChecksum", () => {
  it("is plain SHA-256 of manifest + secret — NOT an HMAC", () => {
    expect(computeWompiChecksum(docEvent(), SECRET)).toBe(expectedChecksum(SECRET));
  });
});

describe("verifyWompiEvent", () => {
  it("accepts a genuine checksum", () => {
    expect(verifyWompiEvent(docEvent(expectedChecksum(SECRET)), SECRET, undefined).ok).toBe(true);
  });

  it("accepts the checksum in upper case, as Wompi's docs print it", () => {
    const upper = expectedChecksum(SECRET).toUpperCase();
    expect(verifyWompiEvent(docEvent(upper), SECRET, upper).ok).toBe(true);
  });

  it("rejects a tampered signed field", () => {
    const event = docEvent(expectedChecksum(SECRET));
    const tampered: WompiEventEnvelope = {
      ...event,
      data: { transaction: { ...sanitiseRecord(event.data["transaction"]), amount_in_cents: 100 } },
    };
    expect(verifyWompiEvent(tampered, SECRET, undefined).ok).toBe(false);
  });

  it("rejects a replayed checksum under a different timestamp", () => {
    const event = docEvent(expectedChecksum(SECRET));
    expect(verifyWompiEvent({ ...event, timestamp: event.timestamp + 1 }, SECRET, undefined).ok).toBe(
      false,
    );
  });

  it("rejects the right event under the wrong secret (e.g. sandbox vs prod)", () => {
    expect(
      verifyWompiEvent(docEvent(expectedChecksum("prod_events_other")), SECRET, undefined).ok,
    ).toBe(false);
  });

  it("rejects a header checksum that disagrees with the body", () => {
    const verdict = verifyWompiEvent(docEvent(expectedChecksum(SECRET)), SECRET, "f".repeat(64));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.diagnostics.headerDisagrees).toBe(true);
    }
  });

  it("reports diagnostics that never contain the secret or a whole digest", () => {
    const verdict = verifyWompiEvent(docEvent("a".repeat(64)), SECRET, undefined);
    expect(verdict.ok).toBe(false);
    const serialised = JSON.stringify(verdict);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain(expectedChecksum(SECRET));
    if (!verdict.ok) {
      expect(verdict.diagnostics.computedChecksumPrefix).toHaveLength(12);
    }
  });
});

describe("schemas", () => {
  it("parses the documented event envelope and its transaction", () => {
    const envelope = wompiEventEnvelopeSchema.parse(docEvent(expectedChecksum(SECRET)));
    const transaction = wompiTransactionSchema.parse(envelope.data["transaction"]);

    expect(transaction).toMatchObject({
      id: "1234-1610641025-49201",
      status: "APPROVED",
      reference: "MZQ3X2DE2SMX",
      amount_in_cents: 4490000,
      currency: "COP",
    });
  });

  it("drops undeclared transaction keys rather than rejecting the payment", () => {
    const parsed = wompiTransactionSchema.parse({
      id: "t1",
      status: "APPROVED",
      reference: "AK-2026-000001-1",
      amount_in_cents: 100,
      currency: "COP",
      something_new: true,
    });
    expect(parsed).not.toHaveProperty("something_new");
  });

  it("keeps an absent amount parseable — absence becomes a mismatch, not a stuck order", () => {
    expect(
      wompiTransactionSchema.safeParse({ id: "t1", status: "APPROVED", reference: "r" }).success,
    ).toBe(true);
  });

  it("refuses an envelope that cannot present a checksum", () => {
    const event = docEvent();
    expect(
      wompiEventEnvelopeSchema.safeParse({ ...event, signature: { properties: [], checksum: "x" } })
        .success,
    ).toBe(false);
  });
});

describe("sanitiseRecord", () => {
  it("drops object-model keys that JSON.parse makes own properties", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"amount_in_cents":1},"id":"t1"}');
    const clean = sanitiseRecord(parsed);
    expect(Object.keys(clean)).toEqual(["id"]);
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
  });

  it("returns an empty record for anything that is not a plain object", () => {
    expect(sanitiseRecord(null)).toEqual({});
    expect(sanitiseRecord([1, 2])).toEqual({});
    expect(sanitiseRecord("x")).toEqual({});
  });
});
