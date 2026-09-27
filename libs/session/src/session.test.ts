import { describe, expect, it } from "vitest";
import { seal } from "./seal";
import {
  applyRefreshedTokens,
  decodeSession,
  encodeSession,
  isAccessTokenExpired,
  isPrivileged,
  isSessionExpired,
  type SessionPayload,
} from "./session";

const SECRET = "test-secret-that-is-at-least-32-chars-long";

function buildSession(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    accessToken: "access-token",
    accessTokenExpiresAt: "2026-07-20T12:15:00.000Z",
    refreshToken: "refresh-token",
    refreshTokenExpiresAt: "2026-08-20T12:00:00.000Z",
    sessionId: "11111111-1111-4111-8111-111111111111",
    customerId: "22222222-2222-4222-8222-222222222222",
    email: "customer@example.com",
    role: "CUSTOMER",
    emailVerified: true,
    twoFactorEnabled: false,
    ...overrides,
  };
}

describe("session encoding", () => {
  it("round-trips a session", async () => {
    const session = buildSession();
    const encoded = await encodeSession(session, SECRET);
    await expect(decodeSession(encoded, SECRET)).resolves.toEqual(session);
  });

  it("returns null for an absent cookie", async () => {
    await expect(decodeSession(undefined, SECRET)).resolves.toBeNull();
    await expect(decodeSession("", SECRET)).resolves.toBeNull();
  });

  it("returns null for a cookie sealed with a different secret", async () => {
    const encoded = await encodeSession(buildSession(), SECRET);
    await expect(decodeSession(encoded, "another-secret-of-at-least-32-characters")).resolves.toBeNull();
  });

  it("rejects an authentic cookie whose payload no longer matches the schema", async () => {
    // The regression this guards: a cookie sealed by a PREVIOUS release. It
    // decrypts perfectly — the key is unchanged — but is missing a field the
    // current type promises. Trusting decryption alone would hand callers a
    // SessionPayload with `undefined` where a string is declared.
    const stale = await seal(JSON.stringify({ accessToken: "only-this-field" }), SECRET);
    await expect(decodeSession(stale, SECRET)).resolves.toBeNull();
  });

  it("rejects a payload carrying unexpected fields", async () => {
    // `.strict()`: a smuggled `role`-adjacent field must not survive into the
    // decoded object even though the rest of the shape is valid.
    const smuggled = await seal(
      JSON.stringify({ ...buildSession(), isSuperUser: true }),
      SECRET,
    );
    await expect(decodeSession(smuggled, SECRET)).resolves.toBeNull();
  });

  it("returns null when the sealed plaintext is not JSON", async () => {
    const notJson = await seal("this is not json", SECRET);
    await expect(decodeSession(notJson, SECRET)).resolves.toBeNull();
  });
});

describe("expiry", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  it("treats an access token expiring beyond the skew as live", () => {
    const session = buildSession({ accessTokenExpiresAt: "2026-07-20T12:10:00.000Z" });
    expect(isAccessTokenExpired(session, now)).toBe(false);
  });

  it("treats an access token expiring INSIDE the skew as already expired", () => {
    // 30 seconds of life left, 60 seconds of skew. Without this the token
    // passes the check, spends time in flight, and arrives expired — which the
    // user experiences as a random sign-out.
    const session = buildSession({ accessTokenExpiresAt: "2026-07-20T12:00:30.000Z" });
    expect(isAccessTokenExpired(session, now)).toBe(true);
  });

  it("applies no skew to the refresh token", () => {
    // Deliberately asymmetric: burning a still-valid second beats attempting a
    // refresh that is guaranteed to fail.
    const session = buildSession({ refreshTokenExpiresAt: "2026-07-20T12:00:30.000Z" });
    expect(isSessionExpired(session, now)).toBe(false);
  });

  it("reports an elapsed refresh token as an expired session", () => {
    const session = buildSession({ refreshTokenExpiresAt: "2026-07-20T11:59:59.000Z" });
    expect(isSessionExpired(session, now)).toBe(true);
  });
});

describe("isPrivileged", () => {
  it.each([
    ["ADMIN", true],
    ["STAFF", true],
    ["CUSTOMER", false],
  ] as const)("returns %s -> %s", (role, expected) => {
    expect(isPrivileged(buildSession({ role }))).toBe(expected);
  });
});

describe("applyRefreshedTokens", () => {
  const tokens = {
    accessToken: "new-access",
    accessTokenExpiresAt: "2026-07-20T12:30:00.000Z",
    refreshToken: "new-refresh",
    refreshTokenExpiresAt: "2026-08-20T12:15:00.000Z",
    sessionId: "33333333-3333-4333-8333-333333333333",
  };

  it("replaces exactly the five token fields", () => {
    const session = buildSession();

    expect(applyRefreshedTokens(session, tokens)).toEqual({
      ...session,
      ...tokens,
    });
  });

  it("carries every identity field over unchanged — the refresh endpoint returns only tokens", () => {
    const session = buildSession({
      email: "someone@example.com",
      role: "STAFF",
      emailVerified: false,
      twoFactorEnabled: true,
    });

    const refreshed = applyRefreshedTokens(session, tokens);

    expect(refreshed.email).toBe("someone@example.com");
    expect(refreshed.role).toBe("STAFF");
    expect(refreshed.emailVerified).toBe(false);
    expect(refreshed.twoFactorEnabled).toBe(true);
  });

  it("is the same merge `middleware.ts`'s own rotate() used to inline — both callers must agree", () => {
    // Not a test of middleware.ts itself, but pins the CONTRACT both callers
    // (the GET-path refresh and the Server-Action retry-on-401) rely on: a
    // fresh `AuthTokens` folds in cleanly with no leftover or missing field.
    const session = buildSession();
    const refreshed = applyRefreshedTokens(session, tokens);

    expect(Object.keys(refreshed).sort()).toEqual(Object.keys(session).sort());
  });
});
