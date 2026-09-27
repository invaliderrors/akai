import type { NextFunction, Request, Response } from "express";

/**
 * Baseline HTTP hardening applied to every API response.
 *
 * `main.ts` configures CORS and then stops; nothing set the headers that keep a
 * response from being framed, MIME-sniffed, or used as a resource by another
 * origin. This is the API's half of that (each Next app sets its own in
 * `next.config.ts`). Hand-rolled rather than pulled from `helmet`: the API
 * serves JSON only, so its policy is a short, explicit list, and adding a
 * dependency mid-migration is a lockfile hazard for no gain here.
 *
 * The logic lives in a pure function so it is unit-tested directly; the Express
 * factory below is the thin adapter `main.ts` mounts.
 */
export interface SecurityHeaderContext {
  /** The raw request path, e.g. `/v1/cart` or `/docs`. */
  readonly path: string;
  /** HSTS is meaningful only over TLS, so it is emitted in production only. */
  readonly isProduction: boolean;
}

export function securityHeaderValues(
  ctx: SecurityHeaderContext,
): Record<string, string> {
  const headers: Record<string, string> = {
    // Stop the browser from second-guessing a declared Content-Type.
    "X-Content-Type-Options": "nosniff",
    // The API renders no pages; it should never be framed.
    "X-Frame-Options": "DENY",
    // A URL under /v1 can carry an order number; never leak it in a Referer.
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
    "X-Permitted-Cross-Domain-Policies": "none",
  };

  if (ctx.isProduction) {
    headers["Strict-Transport-Security"] =
      "max-age=63072000; includeSubDomains; preload";
  }

  // A JSON API can load nothing, so the strictest possible CSP is correct — it
  // turns any injected `<script>`/`<img>` into an inert string. Swagger UI
  // (/docs, non-production only) genuinely needs inline scripts and styles, so
  // it is the one path exempt from the lockdown.
  if (!ctx.path.startsWith("/docs")) {
    headers["Content-Security-Policy"] =
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  }

  return headers;
}

export interface SecurityHeadersOptions {
  readonly isProduction: boolean;
}

/** Express middleware that writes {@link securityHeaderValues} onto each response. */
export function createSecurityHeadersMiddleware(
  options: SecurityHeadersOptions,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    const headers = securityHeaderValues({
      path: request.path,
      isProduction: options.isProduction,
    });
    for (const [name, value] of Object.entries(headers)) {
      response.setHeader(name, value);
    }
    next();
  };
}
