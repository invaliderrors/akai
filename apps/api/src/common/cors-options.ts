import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

import { CART_TOKEN_HEADER } from "../modules/cart/cart.constants";
import { CONTENT_SANITIZED_HEADER } from "../modules/catalog/catalog.constants";

/**
 * The API's CORS policy, as ONE function `main.ts` applies and the api-e2e
 * suites can apply too — so a cross-origin assertion there exercises the
 * policy production runs, not a restatement of it.
 */
export function buildCorsOptions(allowedOrigins: readonly string[]): CorsOptions {
  return {
    origin: [...allowedOrigins],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-CSRF-Token",
      "X-Request-Id",
      "Idempotency-Key",
      // THE GUEST CART CREDENTIAL. Its absence from this list was a silent,
      // total break of the anonymous cart from any browser: the preflight
      // refused the header, so `POST /v1/cart/items` from the storefront could
      // never present a token and every request minted a fresh empty cart.
      // Both lists are required and for different reasons — this one lets the
      // browser SEND the token it holds, `exposedHeaders` below lets it READ
      // the one the API mints. One without the other is still broken.
      CART_TOKEN_HEADER,
    ],
    exposedHeaders: [
      "X-Request-Id",
      // Without this the `x-cart-token` the API sets on cart creation is
      // stripped from the fetch Response by the browser — present on the wire,
      // invisible to JS — so a guest could never persist their basket.
      CART_TOKEN_HEADER,
      // Same failure mode, quieter consequences: the dashboard is a separate
      // origin, so without this entry an admin is never told that their pasted
      // description was rewritten on the way into the database.
      CONTENT_SANITIZED_HEADER,
    ],
    maxAge: 86_400,
  };
}
