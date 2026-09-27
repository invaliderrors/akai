import { describe, expect, it } from "vitest";

import {
  clearedCookieAttributes,
  csrfCookieAttributes,
  secondsUntil,
  sessionCookieAttributes,
} from "./cookies";

/**
 * Cookie scope is what makes single sign-on work, and what makes it dangerous.
 *
 * With a `domain`, the browser presents the session cookie to every host under
 * that parent — which is exactly how the store hands a signed-in customer to the
 * dashboard, and exactly why the parent must be chosen narrowly.
 */

const DEV = { secure: false };
const PROD = { secure: true, domain: ".akai.shop" };

describe("sessionCookieAttributes", () => {
  it("is httpOnly and Lax, so browser JS can never read the sealed session", () => {
    const attributes = sessionCookieAttributes(3600, DEV);
    expect(attributes.httpOnly).toBe(true);
    expect(attributes.sameSite).toBe("lax");
    expect(attributes.path).toBe("/");
  });

  it("omits `domain` entirely when none is given", () => {
    // Host-only. In development the two apps are PORTS on localhost and cookies
    // ignore the port, so they already share a jar with no domain at all.
    expect(sessionCookieAttributes(3600, DEV).domain).toBeUndefined();
    // Not merely undefined-valued: the key must be absent, or a cookie library
    // may serialise `Domain=undefined`.
    expect(Object.hasOwn(sessionCookieAttributes(3600, DEV), "domain")).toBe(false);
  });

  it("carries the parent domain when one IS given — the SSO mechanism", () => {
    expect(sessionCookieAttributes(3600, PROD).domain).toBe(".akai.shop");
  });

  it("treats an empty domain as unset rather than as a literal", () => {
    expect(sessionCookieAttributes(3600, { secure: true, domain: "" }).domain).toBeUndefined();
  });

  it("is Secure only when the deployment says so", () => {
    expect(sessionCookieAttributes(3600, DEV).secure).toBe(false);
    expect(sessionCookieAttributes(3600, PROD).secure).toBe(true);
  });
});

describe("csrfCookieAttributes", () => {
  it("is NOT httpOnly — the page must read it to echo the header back", () => {
    expect(csrfCookieAttributes(3600, DEV).httpOnly).toBe(false);
  });

  it("shares the session's domain, or the two apps disagree about the token", () => {
    expect(csrfCookieAttributes(3600, PROD).domain).toBe(".akai.shop");
  });
});

describe("clearedCookieAttributes", () => {
  it("expires immediately", () => {
    expect(clearedCookieAttributes(true, DEV).maxAge).toBe(0);
  });

  it("repeats the domain, or the delete silently misses", () => {
    // A cookie set on `.akai.shop` is NOT removed by a host-only Set-Cookie of
    // the same name: the browser keeps sending the original, and the visible
    // symptom is "sign-out doesn't work" on one app only.
    expect(clearedCookieAttributes(true, PROD).domain).toBe(".akai.shop");
    expect(clearedCookieAttributes(true, PROD).path).toBe(
      sessionCookieAttributes(3600, PROD).path,
    );
  });
});

describe("secondsUntil", () => {
  it("counts forward from now", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(secondsUntil("2026-01-01T01:00:00.000Z", now)).toBe(3600);
  });

  it("floors at zero rather than returning a negative max-age", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(secondsUntil("2025-01-01T00:00:00.000Z", now)).toBe(0);
  });
});
