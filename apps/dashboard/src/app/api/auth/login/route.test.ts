/**
 * @vitest-environment node
 *
 * Route handlers ARE server code, so node is the honest environment for them.
 * It is also required: `lib/session/server.ts` throws when `window` is defined,
 * which is the guard that stops SESSION_SECRET reaching a client bundle. jsdom
 * defines `window`, so running this suite under the project default would trip
 * that guard — the right response is to test server code in a server
 * environment, not to weaken the guard to accommodate the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The login BFF handler.
 *
 * The property under test above all others: THE TOKEN PAIR MUST NOT APPEAR IN
 * THE RESPONSE BODY. It goes into the sealed cookie and nowhere else. A
 * regression here would not break any feature — sign-in would keep working —
 * which is exactly why it needs a test rather than a code review.
 */

const SECRET = "test-secret-that-is-at-least-32-chars-long";
const COOKIE = "akai_session";
const API = "http://api.internal:3000";

interface StoredCookie {
  readonly value: string;
  readonly options: unknown;
}

const store = new Map<string, StoredCookie>();

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const entry = store.get(name);
        return entry === undefined ? undefined : { name, value: entry.value };
      },
      set: (name: string, value: string, options: unknown) => {
        store.set(name, { value, options });
      },
    }),
}));

const { POST } = await import("./route");

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
  accessToken: "the-access-token",
  accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  refreshToken: "the-refresh-token",
  refreshTokenExpiresAt: "2099-02-01T00:00:00.000Z",
  sessionId: "11111111-1111-4111-8111-111111111111",
} as const;

const CSRF = "csrf-token-value";

function buildRequest(body: unknown, options: { csrf?: boolean } = {}): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.csrf !== false) {
    headers.set("x-csrf-token", CSRF);
    headers.set("cookie", `akai_csrf=${CSRF}`);
  }

  return new NextRequest(new URL("http://localhost:3001/api/auth/login"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function apiResponds(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

beforeEach(() => {
  store.clear();
  vi.stubEnv("API_INTERNAL_URL", API);
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("SESSION_COOKIE_NAME", COOKIE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/auth/login", () => {
  it("sets a sealed session cookie on success", async () => {
    apiResponds({ customer: CUSTOMER, requiresTwoFactor: false, tokens: TOKENS });

    const response = await POST(
      buildRequest({ email: "customer@example.com", password: "password" }),
    );

    expect(response.status).toBe(200);
    expect(store.get(COOKIE)?.value).toBeTruthy();
  });

  it("NEVER puts token material in the response body", async () => {
    apiResponds({ customer: CUSTOMER, requiresTwoFactor: false, tokens: TOKENS });

    const response = await POST(
      buildRequest({ email: "customer@example.com", password: "password" }),
    );
    const raw = await response.text();

    expect(raw).not.toContain(TOKENS.accessToken);
    expect(raw).not.toContain(TOKENS.refreshToken);
    expect(JSON.parse(raw)).toEqual({ requiresTwoFactor: false, customer: CUSTOMER });
  });

  it("stores the cookie ENCRYPTED, not as readable JSON", async () => {
    apiResponds({ customer: CUSTOMER, requiresTwoFactor: false, tokens: TOKENS });

    await POST(buildRequest({ email: "customer@example.com", password: "password" }));

    const cookie = store.get(COOKIE)?.value ?? "";
    expect(cookie).not.toContain(TOKENS.refreshToken);
    expect(cookie.startsWith("v1.")).toBe(true);
  });

  it("marks the session cookie httpOnly, Lax and path-wide", async () => {
    apiResponds({ customer: CUSTOMER, requiresTwoFactor: false, tokens: TOKENS });

    await POST(buildRequest({ email: "customer@example.com", password: "password" }));

    expect(store.get(COOKIE)?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("rotates the CSRF token on sign-in", async () => {
    // Carrying the pre-authentication token across would leave an attacker who
    // planted a known value still holding a valid one afterwards.
    apiResponds({ customer: CUSTOMER, requiresTwoFactor: false, tokens: TOKENS });

    await POST(buildRequest({ email: "customer@example.com", password: "password" }));

    const rotated = store.get("akai_csrf")?.value;
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(CSRF);
  });

  it("creates NO session on the two-factor leg", async () => {
    apiResponds({ requiresTwoFactor: true });

    const response = await POST(
      buildRequest({ email: "customer@example.com", password: "password" }),
    );

    expect(await response.json()).toEqual({ requiresTwoFactor: true });
    // Credentials alone are not authentication when a second factor exists.
    expect(store.has(COOKIE)).toBe(false);
  });

  it("rejects a request with no CSRF pair and never calls the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      buildRequest({ email: "customer@example.com", password: "password" }, { csrf: false }),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.has(COOKIE)).toBe(false);
  });

  it("rejects an unknown field rather than forwarding it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      buildRequest({ email: "a@b.com", password: "pw", role: "ADMIN" }),
    );

    // `.strict()`: a smuggled `role` must not reach the API's Prisma layer.
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards an authentication failure without creating a session", async () => {
    apiResponds(
      {
        error: {
          code: "UNAUTHENTICATED",
          message: "Invalid credentials.",
          requestId: "req-9",
          timestamp: "2026-07-20T12:00:00.000Z",
        },
      },
      401,
    );

    const response = await POST(buildRequest({ email: "a@b.com", password: "wrong" }));

    expect(response.status).toBe(401);
    expect(store.has(COOKIE)).toBe(false);
  });

  it("returns a 400 for a malformed JSON body", async () => {
    const request = new NextRequest(new URL("http://localhost:3001/api/auth/login"), {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "x-csrf-token": CSRF,
        cookie: `akai_csrf=${CSRF}`,
      }),
      body: "{not json",
    });

    expect((await POST(request)).status).toBe(400);
  });
});
