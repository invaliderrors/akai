import type { WompiConfig } from "@akai/config";
import { createLogger } from "@akai/observability";
import { describe, expect, it } from "vitest";

import {
  PaymentProviderRequestError,
  PaymentProviderUnavailableError,
  PaymentsNotConfiguredError,
} from "../payments.errors";
import {
  LiveWompiGateway,
  normaliseWompiBaseUrl,
  wompiErrorReason,
  type FetchLike,
} from "./live-wompi.gateway";

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });

const WOMPI: WompiConfig = {
  environment: "sandbox",
  publicKey: "pub_test_unit",
  privateKey: "prv_test_unit",
  integritySecret: "test_integrity_unit",
  eventsSecret: "test_events_unit",
  apiBaseUrl: "https://sandbox.wompi.co/v1",
  checkoutUrl: "https://checkout.wompi.co/p/",
  eventEnvironment: "test",
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function respondWith(status: number, body: unknown): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

function gateway(fetch: FetchLike, wompi: WompiConfig | null = WOMPI): LiveWompiGateway {
  return new LiveWompiGateway({ wompi }, logger, fetch);
}

const TRANSACTION = {
  id: "1234-1610641025-49201",
  status: "APPROVED",
  reference: "AK-2026-000123-1",
  amount_in_cents: 8_900_000,
  currency: "COP",
  payment_method_type: "CARD",
  payment_method: { extra: { last_four: "4242" } },
};

describe("LiveWompiGateway.getTransaction", () => {
  it("GETs /v1/transactions/{id} on the environment's host with the PRIVATE key", async () => {
    const { fetch, calls } = respondWith(200, { data: TRANSACTION });

    const transaction = await gateway(fetch).getTransaction("1234-1610641025-49201");

    expect(calls[0]?.url).toBe("https://sandbox.wompi.co/v1/transactions/1234-1610641025-49201");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer prv_test_unit");
    expect(transaction).toMatchObject({
      id: "1234-1610641025-49201",
      status: "APPROVED",
      amount_in_cents: 8_900_000,
    });
    // Undeclared fields are dropped at the boundary.
    expect(transaction).not.toHaveProperty("payment_method");
  });

  it("encodes the id, so a hostile id cannot change the path", async () => {
    const { fetch, calls } = respondWith(404, {});

    await gateway(fetch).getTransaction("../merchants/x");

    expect(calls[0]?.url).toBe("https://sandbox.wompi.co/v1/transactions/..%2Fmerchants%2Fx");
  });

  it("answers null for an id Wompi does not know", async () => {
    const { fetch } = respondWith(404, { error: { type: "NOT_FOUND_ERROR" } });

    await expect(gateway(fetch).getTransaction("nope")).resolves.toBeNull();
  });

  it("treats 5xx and 429 as retryable", async () => {
    for (const status of [500, 503, 429]) {
      const { fetch } = respondWith(status, {});
      await expect(gateway(fetch).getTransaction("t")).rejects.toBeInstanceOf(
        PaymentProviderUnavailableError,
      );
    }
  });

  it("treats a transport failure as retryable", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(gateway(failing).getTransaction("t")).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
  });

  it("treats any other 4xx as a rejection, carrying Wompi's reason", async () => {
    const { fetch } = respondWith(401, {
      error: { type: "INVALID_ACCESS_TOKEN", reason: "Se esperaba una llave privada" },
    });

    await expect(gateway(fetch).getTransaction("t")).rejects.toMatchObject({
      constructor: PaymentProviderRequestError,
      providerStatusCode: 401,
      reason: "Se esperaba una llave privada",
    });
  });

  it("refuses a 2xx body that is not a transaction", async () => {
    const { fetch } = respondWith(200, { data: { id: "x" } });

    await expect(gateway(fetch).getTransaction("x")).rejects.toBeInstanceOf(
      PaymentProviderRequestError,
    );
  });

  it("refuses to call Wompi with no keys configured", async () => {
    const { fetch, calls } = respondWith(200, { data: TRANSACTION });

    await expect(gateway(fetch, null).getTransaction("t")).rejects.toBeInstanceOf(
      PaymentsNotConfiguredError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("normaliseWompiBaseUrl", () => {
  it("strips a trailing slash and a trailing /v1, so paths never become /v1/v1", () => {
    expect(normaliseWompiBaseUrl("https://production.wompi.co/v1")).toBe(
      "https://production.wompi.co",
    );
    expect(normaliseWompiBaseUrl("https://production.wompi.co/v1/")).toBe(
      "https://production.wompi.co",
    );
    expect(normaliseWompiBaseUrl("https://sandbox.wompi.co")).toBe("https://sandbox.wompi.co");
  });
});

describe("wompiErrorReason", () => {
  it("reads each documented error shape", () => {
    expect(wompiErrorReason({ error: { type: "T", reason: "r" } })).toBe("r");
    expect(wompiErrorReason({ error: { message: "m" } })).toBe("m");
    expect(wompiErrorReason({ error: { messages: ["first", "second"] } })).toBe("first");
    expect(
      wompiErrorReason({ error: { type: "INPUT_VALIDATION_ERROR", messages: { reference: ["is taken"] } } }),
    ).toBe("reference: is taken");
    expect(wompiErrorReason({ error: { type: "ONLY_TYPE" } })).toBe("ONLY_TYPE");
    expect(wompiErrorReason({ message: "top" })).toBe("top");
  });

  it("answers null for anything else", () => {
    expect(wompiErrorReason(null)).toBeNull();
    expect(wompiErrorReason("text")).toBeNull();
    expect(wompiErrorReason({})).toBeNull();
  });
});
