import { afterEach, describe, expect, it, vi } from "vitest";
import { login, logout, refresh, register } from "./auth";
import { loginResultSchema } from "@akai/session";

const BASE = "http://api.internal:3000";
const CONTEXT = { baseUrl: BASE };

const CUSTOMER = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "customer@example.com",
  emailVerifiedAt: "2026-07-01T10:00:00.000Z",
  firstName: "Ana",
  lastName: "Ruiz",
  phone: null,
  role: "CUSTOMER",
  preferredLocale: "es",
  twoFactorEnabled: false,
  anonymisedAt: null,
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
} as const;

const TOKENS = {
  accessToken: "access",
  accessTokenExpiresAt: "2026-07-20T12:15:00.000Z",
  refreshToken: "refresh",
  refreshTokenExpiresAt: "2026-08-20T12:00:00.000Z",
  sessionId: "11111111-1111-4111-8111-111111111111",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login", () => {
  it("parses a successful token-pair response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ customer: CUSTOMER, requiresTwoFactor: false, tokens: TOKENS }),
      ),
    );

    const result = await login(CONTEXT, { email: "customer@example.com", password: "pw" });

    expect(result.ok).toBe(true);
    if (result.ok && !result.data.requiresTwoFactor) {
      expect(result.data.tokens.accessToken).toBe("access");
      expect(result.data.customer.email).toBe("customer@example.com");
    }
  });

  it("parses the two-factor-required response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ requiresTwoFactor: true })));

    const result = await login(CONTEXT, { email: "customer@example.com", password: "pw" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.requiresTwoFactor).toBe(true);
    }
  });

  it("posts to the versioned login path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ requiresTwoFactor: true }));
    vi.stubGlobal("fetch", fetchMock);

    await login(CONTEXT, { email: "customer@example.com", password: "pw" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/v1/auth/login`);
  });

  it("OMITS the second-factor keys when they are not supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ requiresTwoFactor: true }));
    vi.stubGlobal("fetch", fetchMock);

    await login(CONTEXT, { email: "customer@example.com", password: "pw" });

    const init = fetchMock.mock.calls[0]?.[1] as { body: string };
    const sent: unknown = JSON.parse(init.body);
    // The API's login schema is .strict(): a `totpCode: undefined` key survives
    // JSON.stringify as an absent key, but any explicit null/empty value would
    // be rejected outright. Pinning this stops a regression that would turn
    // every non-2FA sign-in into a 400.
    expect(sent).toEqual({ email: "customer@example.com", password: "pw" });
  });

  it("includes the totp code on the second leg", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ requiresTwoFactor: true }));
    vi.stubGlobal("fetch", fetchMock);

    await login(CONTEXT, { email: "a@b.com", password: "pw", totpCode: "123456" });

    const init = fetchMock.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({ totpCode: "123456" });
  });
});

describe("loginResultSchema", () => {
  it("refuses a success payload that carries no tokens", () => {
    // The union discriminates on the requiresTwoFactor literal, so this shape
    // matches neither branch — which is what makes `result.data.tokens` a
    // compile error on the 2FA branch rather than a runtime undefined.
    expect(
      loginResultSchema.safeParse({ customer: CUSTOMER, requiresTwoFactor: false }).success,
    ).toBe(false);
  });

  it("refuses a two-factor payload that smuggles tokens", () => {
    expect(
      loginResultSchema.safeParse({ requiresTwoFactor: true, tokens: TOKENS }).success,
    ).toBe(false);
  });
});

describe("refresh", () => {
  it("returns the rotated pair", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ tokens: TOKENS })));

    const result = await refresh(CONTEXT, "old-refresh-token");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.tokens.refreshToken).toBe("refresh");
    }
  });

  it("reports a rejected refresh token as a failure rather than throwing", async () => {
    // This is the replay-detection path: the caller must be able to distinguish
    // it and clear the session, not catch an exception.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

    const result = await refresh(CONTEXT, "replayed-token");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAUTHENTICATED");
    }
  });
});

describe("logout", () => {
  it("sends the bearer token and the refresh token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "accepted" }));
    vi.stubGlobal("fetch", fetchMock);

    await logout(CONTEXT, "the-access-token", {
      refreshToken: "the-refresh-token",
      allDevices: true,
    });

    const init = fetchMock.mock.calls[0]?.[1] as {
      body: string;
      headers: Record<string, string>;
    };
    expect(init.headers.authorization).toBe("Bearer the-access-token");
    expect(JSON.parse(init.body)).toEqual({
      allDevices: true,
      refreshToken: "the-refresh-token",
    });
  });
});

describe("register", () => {
  it("returns the neutral acknowledgement", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "accepted" }, 202)));

    const result = await register(CONTEXT, {
      email: "customer@example.com",
      password: "a-long-enough-password",
      firstName: "Ana",
      lastName: "Ruiz",
      preferredLocale: "es",
      turnstileToken: "token",
      marketingConsent: false,
    });

    expect(result).toMatchObject({ ok: true, status: 202, data: { status: "accepted" } });
  });
});
