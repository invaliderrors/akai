// @vitest-environment node
//
// Node, not jsdom. The shared API client pulls in `lib/session/server.ts`,
// which deliberately throws when `window` exists so a server-only module
// carrying SESSION_SECRET can never be bundled into client code. That guard is
// worth keeping sharp, so this suite runs where the code actually runs.
import { describe, expect, it, vi } from "vitest";
import { createAccountApi } from "./account-api";
import { createApiClient } from "@/lib/api/client";
import {
  buildAddress,
  buildCustomer,
  buildOrder,
  buildOrderSummary,
  buildPayment,
  buildShipment,
} from "./fixtures";

/**
 * These tests drive the REAL shared client (`createApiClient`) with a stubbed
 * `fetch`, rather than a hand-rolled fake transport.
 *
 * That is deliberate. A fake client would let this suite pass while the URL,
 * the `/v1` prefix, the bearer header or the 204 handling were wrong — exactly
 * the seams where two slices meet and therefore exactly the seams worth
 * exercising. The only thing stubbed is the network.
 */

interface StubbedCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

function stubFetch(
  responses: readonly { status: number; body?: unknown }[],
): { calls: StubbedCall[] } {
  const calls: StubbedCall[] = [];
  let index = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const rawBody = init?.body;
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof rawBody === "string" ? JSON.parse(rawBody) : null,
        headers: (init?.headers ?? {}) as Readonly<Record<string, string>>,
      });

      const next = responses[index];
      index += 1;
      if (next === undefined) {
        throw new Error(`stubFetch ran out of responses at call ${index}`);
      }

      // `null`, not `""`. The Fetch spec forbids a body on a null-body status
      // (204/205/304) and undici throws a TypeError for one — which would
      // surface here as a misleading "could not reach the API" network error.
      return new Response(
        next.body === undefined ? null : JSON.stringify(next.body),
        {
          status: next.status,
          headers: { "content-type": "application/json" },
        },
      );
    }),
  );

  return { calls };
}

function api(responses: readonly { status: number; body?: unknown }[]) {
  const { calls } = stubFetch(responses);
  const client = createApiClient("https://api.test", {
    accessToken: "test-access-token",
    accessTokenExpiresAt: "2026-03-02T10:00:00.000Z",
    refreshToken: "test-refresh-token",
    refreshTokenExpiresAt: "2026-04-02T10:00:00.000Z",
    sessionId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    customerId: "11111111-1111-4111-8111-111111111111",
    email: "elena@example.com",
    role: "CUSTOMER",
    emailVerified: true,
    twoFactorEnabled: false,
  });
  return { calls, account: createAccountApi(client) };
}

function errorBody(code: string, message: string): unknown {
  return {
    error: {
      code,
      message,
      requestId: "req_abc123",
      timestamp: "2026-03-02T09:30:00.000Z",
    },
  };
}

describe("createAccountApi", () => {
  describe("getProfile", () => {
    it("parses the response into a Customer", async () => {
      const { account } = api([{ status: 200, body: buildCustomer() }]);

      const result = await account.getProfile();

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.data.email).toBe("elena@example.com");
    });

    it("hits the versioned /v1/me path with a bearer token", async () => {
      const { account, calls } = api([{ status: 200, body: buildCustomer() }]);

      await account.getProfile();

      expect(calls[0]?.url).toBe("https://api.test/v1/me");
      expect(calls[0]?.headers).toMatchObject({
        authorization: "Bearer test-access-token",
      });
    });

    it("fails rather than returning a malformed payload", async () => {
      // Without a parse, a renamed API field renders `undefined` into the page.
      const { account } = api([{ status: 200, body: { id: "not-a-uuid" } }]);

      const result = await account.getProfile();

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("INTERNAL_ERROR");
    });
  });

  describe("updateProfile", () => {
    it("PATCHes /me and returns the updated customer", async () => {
      const { account, calls } = api([
        { status: 200, body: buildCustomer({ firstName: "Elena María" }) },
      ]);

      const result = await account.updateProfile({ firstName: "Elena María" });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.data.firstName).toBe("Elena María");
      expect(calls[0]?.method).toBe("PATCH");
      expect(calls[0]?.body).toEqual({ firstName: "Elena María" });
    });

    it("rejects an unknown field before it reaches the wire", async () => {
      const { account, calls } = api([{ status: 200, body: buildCustomer() }]);

      // `role` is not an updatable field. A strict request schema means this
      // never becomes a request the server has to defend against.
      await expect(
        account.updateProfile({ role: "ADMIN" } as unknown as { firstName?: string }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });
  });

  describe("listOrders", () => {
    it("returns the paginated envelope", async () => {
      const { account } = api([
        {
          status: 200,
          body: {
            items: [buildOrderSummary()],
            nextCursor: "22222222-2222-4222-8222-222222222222",
            hasMore: true,
          },
        },
      ]);

      const result = await account.listOrders();

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.data.items).toHaveLength(1);
      expect(result.data.hasMore).toBe(true);
    });

    it("serialises cursor and limit into the query string", async () => {
      const { account, calls } = api([
        { status: 200, body: { items: [], nextCursor: null, hasMore: false } },
      ]);

      await account.listOrders({ cursor: "abc", limit: 10 });

      expect(calls[0]?.url).toBe("https://api.test/v1/orders?cursor=abc&limit=10");
    });

    it("omits absent pagination parameters entirely", async () => {
      // `?cursor=undefined` is a real bug class — the server sees a
      // present-but-nonsense cursor and silently returns page one forever.
      const { account, calls } = api([
        { status: 200, body: { items: [], nextCursor: null, hasMore: false } },
      ]);

      await account.listOrders();

      expect(calls[0]?.url).toBe("https://api.test/v1/orders");
    });
  });

  describe("getOrder", () => {
    it("returns the order with empty shipments when the API omits them", async () => {
      const { account } = api([{ status: 200, body: buildOrder() }]);

      const result = await account.getOrder("AK-2026-000123");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.data.order.orderNumber).toBe("AK-2026-000123");
      expect(result.data.shipments).toEqual([]);
      expect(result.data.payment).toBeNull();
    });

    it("surfaces shipments and payment once the API includes them", async () => {
      // Forward-compatibility is the point: orderSchema is .strict(), so a
      // naive parse would REJECT the richer response the moment the API mapper
      // starts sending it. This pins that it does not.
      const { account } = api([
        {
          status: 200,
          body: {
            ...buildOrder(),
            shipments: [buildShipment()],
            payment: buildPayment(),
          },
        },
      ]);

      const result = await account.getOrder("AK-2026-000123");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.data.shipments).toHaveLength(1);
      expect(result.data.shipments[0]?.trackingNumber).toBe("SEUR-9981234");
      expect(result.data.payment?.cardLast4).toBe("4242");
    });

    it("returns a NOT_FOUND result rather than throwing", async () => {
      const { account } = api([
        { status: 404, body: errorBody("NOT_FOUND", "Order not found") },
      ]);

      const result = await account.getOrder("AK-2026-000999");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.requestId).toBe("req_abc123");
    });
  });

  describe("addresses", () => {
    it("lists addresses", async () => {
      const { account } = api([{ status: 200, body: [buildAddress()] }]);

      const result = await account.listAddresses();

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.data[0]?.city).toBe("Madrid");
    });

    it("deletes an address and tolerates a 204 with no body", async () => {
      const { account, calls } = api([{ status: 204 }]);

      const result = await account.deleteAddress(
        "55555555-5555-4555-8555-555555555555",
      );

      expect(result.ok).toBe(true);
      expect(calls[0]?.method).toBe("DELETE");
    });

    it("surfaces field-level validation errors for inline display", async () => {
      const { account } = api([
        {
          status: 400,
          body: {
            error: {
              code: "VALIDATION_FAILED",
              message: "Validation failed",
              fields: [{ path: "postalCode", message: "Invalid postal code" }],
              requestId: "req_abc123",
              timestamp: "2026-03-02T09:30:00.000Z",
            },
          },
        },
      ]);

      const result = await account.createAddress({
        type: "SHIPPING",
        firstName: "Elena",
        lastName: "Ruiz",
        company: null,
        line1: "Calle Mayor 12",
        line2: null,
        city: "Madrid",
        region: null,
        postalCode: "X",
        countryCode: "ES",
        phone: null,
        isDefault: false,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.fields).toEqual([
        { path: "postalCode", message: "Invalid postal code" },
      ]);
    });
  });

  describe("changePassword", () => {
    it("posts to the auth endpoint and accepts an empty 204", async () => {
      const { account, calls } = api([{ status: 204 }]);

      const result = await account.changePassword({
        currentPassword: "old-password-123",
        newPassword: "a-much-longer-new-passphrase",
      });

      expect(result.ok).toBe(true);
      expect(calls[0]?.url).toBe("https://api.test/v1/auth/password/change");
    });

    it("refuses a new password shorter than the platform minimum", async () => {
      const { account, calls } = api([{ status: 204 }]);

      // The 12-character floor is the contract's `passwordSchema` policy. It is
      // enforced client-side too so the user gets an instant answer, but the
      // API remains the authority.
      await expect(
        account.changePassword({
          currentPassword: "old-password-123",
          newPassword: "short",
        }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });
  });
});
