import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Role } from "@akai/contracts";
import middleware from "./middleware";
import { resetServerEnvCache } from "./lib/env";
import { encodeSession, type SessionPayload } from "@akai/session";

/**
 * Middleware is where anonymous / CUSTOMER / ADMIN is actually decided for a
 * real request, and where the single-use refresh token is spent. `route-policy`
 * covers the rules in isolation; this covers the WIRING — cookie decode, the
 * refresh guard, and the cookies written onto the response.
 */

const SECRET = "test-secret-that-is-at-least-32-chars-long";
const COOKIE = "akai_session";
const API = "http://api.internal:3000";
const ORIGIN = "http://localhost:3001";

function buildSession(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    accessToken: "access-token",
    // Far future: not due for refresh unless a test says so.
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    refreshToken: "refresh-token",
    refreshTokenExpiresAt: "2099-02-01T00:00:00.000Z",
    sessionId: "11111111-1111-4111-8111-111111111111",
    customerId: "22222222-2222-4222-8222-222222222222",
    email: "customer@example.com",
    role: "CUSTOMER",
    emailVerified: true,
    twoFactorEnabled: false,
    ...overrides,
  };
}

/** A top-level document navigation — the only kind allowed to refresh. */
async function request(
  path: string,
  options: { session?: SessionPayload | null; headers?: Record<string, string> } = {},
): Promise<NextRequest> {
  const headers = new Headers({
    "sec-fetch-dest": "document",
    ...options.headers,
  });

  const session = options.session ?? null;
  if (session !== null) {
    headers.set("cookie", `${COOKIE}=${await encodeSession(session, SECRET)}`);
  }

  return new NextRequest(new URL(path, ORIGIN), { headers });
}

function sessionWithRole(role: Role): SessionPayload {
  return buildSession({ role });
}

beforeEach(() => {
  vi.stubEnv("API_INTERNAL_URL", API);
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("SESSION_COOKIE_NAME", COOKIE);
  resetServerEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetServerEnvCache();
});

describe("anonymous visitors", () => {
  it("redirects a protected page to sign-in, preserving the destination", async () => {
    const response = await middleware(await request("/orders"));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("next")).toBe("/orders");
  });

  it("allows the sign-in page", async () => {
    const response = await middleware(await request("/sign-in"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("issues a CSRF cookie when the visitor has none", async () => {
    // Every mutating BFF route requires the double-submit pair, and a visitor
    // arriving from an email link has no cookies at all. If middleware did not
    // seed one here, the very first sign-in attempt would 403.
    const response = await middleware(await request("/sign-in"));
    expect(response.cookies.get("akai_csrf")?.value).toBeTruthy();
  });

  it("keeps the locale prefix when redirecting an English visitor", async () => {
    const response = await middleware(await request("/en/orders"));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/en/sign-in");
    expect(location.searchParams.get("next")).toBe("/en/orders");
  });
});

describe("role gating", () => {
  it("redirects a CUSTOMER away from an admin route", async () => {
    const response = await middleware(
      await request("/admin/products", { session: sessionWithRole("CUSTOMER") }),
    );

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/");
  });

  it.each(["STAFF", "ADMIN"] as const)("allows %s into an admin route", async (role) => {
    const response = await middleware(
      await request("/admin/products", { session: sessionWithRole(role) }),
    );

    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects a signed-in visitor away from the sign-in page", async () => {
    const response = await middleware(await request("/sign-in", { session: buildSession() }));

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/");
  });
});

describe("forged and expired cookies", () => {
  it("treats an undecryptable cookie as anonymous rather than erroring", async () => {
    const forged = new NextRequest(new URL("/orders", ORIGIN), {
      headers: new Headers({
        "sec-fetch-dest": "document",
        cookie: `${COOKIE}=v1.notreallysealed.atall`,
      }),
    });

    const response = await middleware(forged);

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/sign-in");
  });

  it("clears the cookie when the refresh token has expired", async () => {
    // Leaving a known-dead cookie in place is what produces the sign-in →
    // page → sign-in redirect loop.
    const dead = buildSession({
      accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2020-01-02T00:00:00.000Z",
    });

    const response = await middleware(await request("/orders", { session: dead }));

    expect(response.cookies.get(COOKIE)?.value).toBe("");
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/sign-in");
  });
});

describe("token rotation", () => {
  const stale = () => buildSession({ accessTokenExpiresAt: "2020-01-01T00:00:00.000Z" });

  it("refreshes an expired access token on a document navigation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          tokens: {
            accessToken: "new-access",
            accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
            refreshToken: "new-refresh",
            refreshTokenExpiresAt: "2099-02-01T00:00:00.000Z",
            sessionId: "11111111-1111-4111-8111-111111111111",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await middleware(await request("/orders", { session: stale() }));

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API}/v1/auth/refresh`);
    // A NEW sealed cookie is written; the request is then allowed through.
    expect(response.cookies.get(COOKIE)?.value).toBeTruthy();
    expect(response.cookies.get(COOKIE)?.value).not.toBe("");
    expect(response.headers.get("location")).toBeNull();
  });

  it("does NOT refresh on a prefetch", async () => {
    // Refresh tokens are single-use with replay detection. A page load fires a
    // document request plus several prefetches; if each tried to rotate, the
    // first would win and the rest would look like a stolen-token replay,
    // revoking the family and signing the user out by their own navigation.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await middleware(
      await request("/orders", {
        session: stale(),
        headers: { "next-router-prefetch": "1" },
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT refresh on an RSC payload request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await middleware(
      await request("/orders", { session: stale(), headers: { rsc: "1" } }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the session and redirects when the refresh token is rejected", async () => {
    // The replay-detection path: the API has revoked the whole family.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

    const response = await middleware(await request("/orders", { session: stale() }));

    expect(response.cookies.get(COOKIE)?.value).toBe("");
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/sign-in");
  });

  it("does not refresh a token that is still comfortably valid", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await middleware(await request("/orders", { session: buildSession() }));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
