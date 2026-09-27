import { describe, expect, it } from "vitest";

import { securityHeaderValues } from "./security-headers";

describe("securityHeaderValues", () => {
  it("sets the baseline hardening headers on an ordinary API path", () => {
    const headers = securityHeaderValues({ path: "/v1/cart", isProduction: false });

    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("emits HSTS only in production", () => {
    expect(
      securityHeaderValues({ path: "/v1/cart", isProduction: false })[
        "Strict-Transport-Security"
      ],
    ).toBeUndefined();

    expect(
      securityHeaderValues({ path: "/v1/cart", isProduction: true })[
        "Strict-Transport-Security"
      ],
    ).toBe("max-age=63072000; includeSubDomains; preload");
  });

  it("omits the lockdown CSP for the Swagger docs path but keeps the rest", () => {
    const headers = securityHeaderValues({ path: "/docs", isProduction: false });

    expect(headers["Content-Security-Policy"]).toBeUndefined();
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });
});
