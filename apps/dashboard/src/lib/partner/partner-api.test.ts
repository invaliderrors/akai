// @vitest-environment node
//
// Node, not jsdom — same reasoning as `account-api.test.ts`: the real shared
// client pulls in `lib/session/server.ts`, which throws if `window` exists.
import { describe, expect, it, vi } from "vitest";
import { getPartnerStats } from "./partner-api";
import { createApiClient } from "@/lib/api/client";

interface StubbedCall {
  readonly url: string;
  readonly method: string;
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
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Readonly<Record<string, string>>,
      });

      const next = responses[index];
      index += 1;
      if (next === undefined) {
        throw new Error(`stubFetch ran out of responses at call ${index}`);
      }

      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  return { calls };
}

function client(responses: readonly { status: number; body?: unknown }[]) {
  const { calls } = stubFetch(responses);
  const api = createApiClient("https://api.test", {
    accessToken: "test-access-token",
    accessTokenExpiresAt: "2026-03-02T10:00:00.000Z",
    refreshToken: "test-refresh-token",
    refreshTokenExpiresAt: "2026-04-02T10:00:00.000Z",
    sessionId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    customerId: "11111111-1111-4111-8111-111111111111",
    email: "ana@example.com",
    role: "PARTNER",
    emailVerified: true,
    twoFactorEnabled: false,
  });
  return { calls, api };
}

describe("getPartnerStats", () => {
  it("hits GET /v1/partner/me with the bearer token, no id in the path", async () => {
    const { api, calls } = client([
      { status: 200, body: { discountCodes: ["AMIGO10"], redemptionCount: 4 } },
    ]);

    const result = await getPartnerStats(api);

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://api.test/v1/partner/me");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers).toMatchObject({ authorization: "Bearer test-access-token" });
  });

  it("parses discountCodes and redemptionCount", async () => {
    const { api } = client([
      { status: 200, body: { discountCodes: ["AMIGO10", "AMIGO20"], redemptionCount: 9 } },
    ]);

    const result = await getPartnerStats(api);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.data.discountCodes).toEqual(["AMIGO10", "AMIGO20"]);
    expect(result.data.redemptionCount).toBe(9);
  });

  it("never accepts or parses a revenue figure — the type has no field for it", async () => {
    const { api } = client([
      {
        status: 200,
        body: { discountCodes: ["AMIGO10"], redemptionCount: 4, revenueMinor: 999_99 },
      },
    ]);

    const result = await getPartnerStats(api);

    // The `.strict()` schema rejects the unexpected extra field outright,
    // rather than silently admitting it — the same defence-in-depth the
    // narrower TYPE already gives, one layer further out.
    expect(result.ok).toBe(false);
  });

  it("fails rather than returning a malformed payload", async () => {
    const { api } = client([{ status: 200, body: { redemptionCount: "not-a-number" } }]);

    const result = await getPartnerStats(api);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("INTERNAL_ERROR");
  });

  it("surfaces a forbidden rather than an empty result", async () => {
    const { api } = client([
      {
        status: 403,
        body: {
          error: {
            code: "FORBIDDEN",
            message: "Partner role required",
            requestId: "req_1",
            timestamp: "2026-03-02T09:30:00.000Z",
          },
        },
      },
    ]);

    const result = await getPartnerStats(api);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("FORBIDDEN");
  });
});
