import { describe, expect, it } from "vitest";
import type { Role } from "@akai/contracts";
import {
  DASHBOARD_HOME_PATH,
  SIGN_IN_PATH,
  classifyPath,
  decideAccess,
  normalisePathname,
  sanitiseNextPath,
} from "./route-policy";

function session(role: Role) {
  return { role };
}

describe("classifyPath", () => {
  it.each([
    ["/sign-in", "anonymous-only"],
    ["/sign-up", "anonymous-only"],
    ["/forgot-password", "anonymous-only"],
    ["/reset-password", "anonymous-only"],
    ["/verify-email", "public"],
    ["/admin", "privileged"],
    ["/admin/products", "privileged"],
    ["/admin/orders/AK-2026-000001", "privileged"],
    ["/partner", "partner"],
    ["/", "authenticated"],
    ["/orders", "authenticated"],
    ["/profile", "authenticated"],
  ] as const)("classifies %s as %s", (pathname, expected) => {
    expect(classifyPath(pathname)).toBe(expected);
  });

  it("does not treat a path that merely starts with a prefix as that prefix", () => {
    // `startsWith` without a segment boundary would classify these wrongly —
    // and `/administrators` being read as `/admin` is the dangerous direction.
    expect(classifyPath("/sign-in-help")).toBe("authenticated");
    expect(classifyPath("/administrators")).toBe("authenticated");
    expect(classifyPath("/partnerships")).toBe("authenticated");
  });

  it("defaults an unknown path to authenticated", () => {
    // Deny by default: a page another slice adds tomorrow is protected the
    // moment it exists, without anyone remembering to update this file.
    expect(classifyPath("/some/page/nobody/has/written/yet")).toBe("authenticated");
  });
});

describe("decideAccess", () => {
  it("redirects an anonymous visitor away from a protected page", () => {
    expect(decideAccess({ pathname: "/orders", session: null })).toEqual({
      kind: "redirect",
      path: SIGN_IN_PATH,
      reason: "unauthenticated",
    });
  });

  it("lets an anonymous visitor reach the sign-in page", () => {
    expect(decideAccess({ pathname: "/sign-in", session: null })).toEqual({ kind: "allow" });
  });

  it("redirects a signed-in visitor away from the sign-in page", () => {
    // Rendering it would let them create a SECOND session and orphan the first.
    expect(decideAccess({ pathname: "/sign-in", session: session("CUSTOMER") })).toEqual({
      kind: "redirect",
      path: DASHBOARD_HOME_PATH,
      reason: "already-signed-in",
    });
  });

  it("allows verify-email in BOTH states", () => {
    // The link is clicked from a mail client that may already hold a session;
    // bouncing that user would leave the address permanently unverified.
    expect(decideAccess({ pathname: "/verify-email", session: null })).toEqual({ kind: "allow" });
    expect(
      decideAccess({ pathname: "/verify-email", session: session("CUSTOMER") }),
    ).toEqual({ kind: "allow" });
  });

  it("redirects a CUSTOMER away from every admin route", () => {
    for (const pathname of ["/admin", "/admin/products", "/admin/orders/AK-1"]) {
      expect(decideAccess({ pathname, session: session("CUSTOMER") })).toEqual({
        kind: "redirect",
        path: DASHBOARD_HOME_PATH,
        reason: "insufficient-role",
      });
    }
  });

  it.each(["STAFF", "ADMIN"] as const)("allows %s into admin routes", (role) => {
    expect(decideAccess({ pathname: "/admin/products", session: session(role) })).toEqual({
      kind: "allow",
    });
  });

  it("sends an anonymous visitor to sign-in for an admin route, not to home", () => {
    // Ordering matters: the anonymous check must run before the role check, or
    // an unauthenticated request would be bounced to a home page that then
    // bounces it to sign-in.
    expect(decideAccess({ pathname: "/admin", session: null })).toEqual({
      kind: "redirect",
      path: SIGN_IN_PATH,
      reason: "unauthenticated",
    });
  });

  it.each(["CUSTOMER", "STAFF", "ADMIN"] as const)(
    "redirects %s away from the partner route — an ALLOW-list, not a deny-list",
    (role) => {
      // Unlike "privileged" above (which only excludes CUSTOMER), this must
      // reject every role except PARTNER by name — including STAFF and ADMIN,
      // which the privileged check would let through were it reused here.
      expect(decideAccess({ pathname: "/partner", session: session(role) })).toEqual({
        kind: "redirect",
        path: DASHBOARD_HOME_PATH,
        reason: "insufficient-role",
      });
    },
  );

  it("allows PARTNER into the partner route", () => {
    expect(decideAccess({ pathname: "/partner", session: session("PARTNER") })).toEqual({
      kind: "allow",
    });
  });

  it("sends an anonymous visitor to sign-in for the partner route, not to home", () => {
    expect(decideAccess({ pathname: "/partner", session: null })).toEqual({
      kind: "redirect",
      path: SIGN_IN_PATH,
      reason: "unauthenticated",
    });
  });

  it("redirects PARTNER away from every admin route", () => {
    // The exact case the privileged deny-list would silently miss.
    expect(decideAccess({ pathname: "/admin/products", session: session("PARTNER") })).toEqual({
      kind: "redirect",
      path: DASHBOARD_HOME_PATH,
      reason: "insufficient-role",
    });
  });
});

describe("normalisePathname", () => {
  it.each([
    ["/orders", "/orders"],
    ["/orders/", "/orders"],
    ["/", "/"],
  ] as const)("normalises %s", (input, pathname) => {
    expect(normalisePathname(input)).toBe(pathname);
  });

  it("leaves a former locale prefix alone — /en is just an unknown path now", () => {
    expect(normalisePathname("/en/orders")).toBe("/en/orders");
  });
});

describe("sanitiseNextPath", () => {
  it("keeps a safe relative path", () => {
    expect(sanitiseNextPath("/orders")).toBe("/orders");
    expect(sanitiseNextPath("/orders/")).toBe("/orders");
  });

  it("preserves the query string", () => {
    // Dropping it would silently reset a paginated list to page one.
    expect(sanitiseNextPath("/orders?cursor=abc")).toBe("/orders?cursor=abc");
  });

  it.each([
    ["an absolute URL", "https://evil.example.com/"],
    ["a protocol-relative URL", "//evil.example.com/"],
    ["a backslash-escaped host", "/\\evil.example.com"],
    ["a bare word", "evil.example.com"],
    ["nothing at all", null],
  ])("refuses %s", (_label, raw) => {
    // Open-redirect defence: `next` arrives from a URL anyone can craft and
    // mail to a user, who then signs in successfully and lands on the
    // attacker's page still trusting it.
    expect(sanitiseNextPath(raw)).toBe(DASHBOARD_HOME_PATH);
  });

  it("refuses to bounce back to an anonymous-only page", () => {
    // Otherwise sign-in would redirect to sign-in, which redirects to home —
    // a visible flicker at best and a loop at worst.
    expect(sanitiseNextPath("/sign-in")).toBe(DASHBOARD_HOME_PATH);
  });
});
