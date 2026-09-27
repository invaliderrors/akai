import "reflect-metadata";
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Clock } from "../ports/clock.port";
import { AccessTokenService, type AccessTokenOptions } from "./access-token.service";

/**
 * Attack-shaped tests for the hand-rolled HS512 verifier.
 *
 * Writing a JWT implementation is only defensible if the classic forgeries are
 * demonstrably rejected, so each one is exercised here as an explicit attempt
 * rather than implied by a happy-path round-trip:
 *
 *   - `alg: none`               (accept an unsigned token)
 *   - algorithm substitution    (HS256 body with an HS512 verifier)
 *   - payload tampering         (privilege escalation via an edited claim)
 *   - wrong key                 (a token from another environment)
 *   - expiry, issuer, audience  (replay across time or across services)
 */

const SECRET = "test-secret-at-least-32-characters-long!!";
const OTHER_SECRET = "a-different-secret-also-32-characters-!!!";

const NOW = new Date("2026-07-20T12:00:00.000Z");

function build(
  overrides: Partial<AccessTokenOptions> = {},
  clockNow: () => Date = () => NOW,
): AccessTokenService {
  const clock: Clock = { now: clockNow };
  return new AccessTokenService(
    {
      secret: SECRET,
      ttlMs: 15 * 60 * 1000,
      issuer: "akai-api",
      audience: "akai-dashboard",
      clockToleranceSeconds: 30,
      ...overrides,
    },
    clock,
  );
}

const SUBJECT = { customerId: randomUUID(), sessionId: randomUUID(), role: "CUSTOMER" } as const;

function base64Url(value: object): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("AccessTokenService — issuing and verifying", () => {
  it("round-trips a token and returns the claims", () => {
    const service = build();
    const issued = service.issue(SUBJECT);
    const result = service.verify(issued.token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.sub).toBe(SUBJECT.customerId);
    expect(result.payload.sessionId).toBe(SUBJECT.sessionId);
    expect(result.payload.role).toBe("CUSTOMER");
    expect(result.payload.iss).toBe("akai-api");
    expect(result.payload.aud).toBe("akai-dashboard");
  });

  it("stamps the expiry from the configured TTL", () => {
    const service = build({ ttlMs: 15 * 60 * 1000 });
    const issued = service.issue(SUBJECT);
    expect(issued.expiresAt.getTime()).toBe(NOW.getTime() + 15 * 60 * 1000);
  });

  it("gives every token a unique id", () => {
    const service = build();
    expect(service.issue(SUBJECT).jti).not.toBe(service.issue(SUBJECT).jti);
  });
});

describe("AccessTokenService — forgery attempts", () => {
  it('rejects an "alg: none" token', () => {
    const service = build();
    const header = base64Url({ alg: "none", typ: "JWT" });
    const payload = base64Url({
      sub: SUBJECT.customerId,
      sessionId: SUBJECT.sessionId,
      role: "ADMIN",
      jti: randomUUID(),
      iss: "akai-api",
      aud: "akai-dashboard",
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 900,
    });

    // The canonical attack: drop the signature entirely and declare no algorithm.
    expect(service.verify(`${header}.${payload}.`).ok).toBe(false);
    expect(service.verify(`${header}.${payload}.x`).ok).toBe(false);
  });

  it("rejects an HS256 token signed with the same secret (algorithm substitution)", () => {
    const service = build();
    const header = base64Url({ alg: "HS256", typ: "JWT" });
    const payload = base64Url({
      sub: SUBJECT.customerId,
      sessionId: SUBJECT.sessionId,
      role: "ADMIN",
      jti: randomUUID(),
      iss: "akai-api",
      aud: "akai-dashboard",
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 900,
    });
    const signature = createHmac("sha256", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");

    // Rejected because the verifier NEVER consults `alg` to pick a primitive —
    // it always computes HMAC-SHA512, which cannot match an HMAC-SHA256 tag.
    const result = service.verify(`${header}.${payload}.${signature}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-signature");
  });

  it("rejects a token whose role claim was edited after signing", () => {
    const service = build();
    const issued = service.issue(SUBJECT);
    const [header, payload, signature] = issued.token.split(".");

    expect(payload).toBeDefined();
    const decoded: unknown = JSON.parse(
      Buffer.from(payload ?? "", "base64").toString("utf8"),
    );
    expect(typeof decoded).toBe("object");

    const escalated = base64Url({
      ...(decoded as Record<string, unknown>),
      role: "ADMIN",
    });

    const result = service.verify(`${header}.${escalated}.${signature}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-signature");
  });

  it("rejects a token signed with a different key", () => {
    const minted = build({ secret: OTHER_SECRET }).issue(SUBJECT);
    const result = build().verify(minted.token);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-signature");
  });

  it("rejects structurally malformed tokens rather than throwing", () => {
    const service = build();
    for (const bad of ["", "a", "a.b", "a.b.c.d", "..", "a..c", "....."]) {
      // Returning a typed failure instead of throwing matters: an exception
      // here would surface as a 500 and distinguish malformed input from a
      // merely-invalid token.
      expect(() => service.verify(bad)).not.toThrow();
      expect(service.verify(bad).ok).toBe(false);
    }
  });

  it("rejects non-canonical base64url that decodes to a valid payload", () => {
    const service = build();
    const issued = service.issue(SUBJECT);
    const [header, payload, signature] = issued.token.split(".");

    // Appending '=' padding decodes to identical bytes under Node's lenient
    // base64 reader. Accepting it would mean one signature covers several
    // distinct token strings.
    expect(service.verify(`${header}.${payload}=.${signature}`).ok).toBe(false);
  });
});

describe("AccessTokenService — temporal and cross-service replay", () => {
  it("rejects an expired token", () => {
    let now = NOW;
    const service = build({ ttlMs: 60_000, clockToleranceSeconds: 0 }, () => now);
    const issued = service.issue(SUBJECT);

    now = new Date(NOW.getTime() + 61_000);

    const result = service.verify(issued.token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("expired");
  });

  it("still accepts a token one second before expiry", () => {
    let now = NOW;
    const service = build({ ttlMs: 60_000, clockToleranceSeconds: 0 }, () => now);
    const issued = service.issue(SUBJECT);

    now = new Date(NOW.getTime() + 59_000);
    expect(service.verify(issued.token).ok).toBe(true);
  });

  it("tolerates modest clock skew but not an arbitrary amount", () => {
    let now = NOW;
    const service = build({ ttlMs: 60_000, clockToleranceSeconds: 30 }, () => now);
    const issued = service.issue(SUBJECT);

    now = new Date(NOW.getTime() + 80_000); // 20s past expiry, inside tolerance
    expect(service.verify(issued.token).ok).toBe(true);

    now = new Date(NOW.getTime() + 100_000); // 40s past expiry, outside it
    expect(service.verify(issued.token).ok).toBe(false);
  });

  it("rejects a token minted for a different issuer or audience", () => {
    const foreignIssuer = build({ issuer: "someone-else" }).issue(SUBJECT);
    const wrongIssuer = build().verify(foreignIssuer.token);
    expect(wrongIssuer.ok).toBe(false);
    if (!wrongIssuer.ok) {
      expect(wrongIssuer.reason).toBe("wrong-issuer");
    }

    const foreignAudience = build({ audience: "another-service" }).issue(SUBJECT);
    const wrongAudience = build().verify(foreignAudience.token);
    expect(wrongAudience.ok).toBe(false);
    if (!wrongAudience.ok) {
      expect(wrongAudience.reason).toBe("wrong-audience");
    }
  });

  it("rejects a correctly-signed token carrying an unknown role", () => {
    // A signature alone is not enough: the claim set is re-validated with zod,
    // so a token minted by a future version with a role this build does not
    // understand fails closed rather than being partially trusted.
    const header = base64Url({ alg: "HS512", typ: "JWT" });
    const payload = base64Url({
      sub: SUBJECT.customerId,
      sessionId: SUBJECT.sessionId,
      role: "SUPERADMIN",
      jti: randomUUID(),
      iss: "akai-api",
      aud: "akai-dashboard",
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 900,
    });
    const signature = createHmac("sha512", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");

    const result = build().verify(`${header}.${payload}.${signature}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-payload");
  });

  it("rejects a correctly-signed token carrying extra claims", () => {
    // `.strict()` on the payload schema: an attacker who influenced any field
    // cannot append one.
    const header = base64Url({ alg: "HS512", typ: "JWT" });
    const payload = base64Url({
      sub: SUBJECT.customerId,
      sessionId: SUBJECT.sessionId,
      role: "CUSTOMER",
      jti: randomUUID(),
      iss: "akai-api",
      aud: "akai-dashboard",
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 900,
      impersonate: "someone-else",
    });
    const signature = createHmac("sha512", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");

    expect(build().verify(`${header}.${payload}.${signature}`).ok).toBe(false);
  });
});
