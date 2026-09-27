import {
  addCartItemSchema,
  cartSchema,
  checkoutSessionResponseSchema,
  createCheckoutSessionSchema,
  orderStatusResponseSchema,
  shippingQuoteRequestSchema,
  shippingQuoteResponseSchema,
  type Cart,
  type Locale,
} from "@akai/contracts";
import { z } from "zod";

import { apiRequest, type HttpMethod } from "./http";

/**
 * Browser-side commerce calls. They go STRAIGHT to the API — the API's
 * throttles key on the caller's address, and proxying through the storefront
 * would collapse every shopper into one bucket.
 *
 * A guest cart is identified by an opaque token the API mints on first write
 * and returns in `x-cart-token`; we keep it in a first-party cookie.
 */
export const CART_TOKEN_HEADER = "x-cart-token";
const CART_TOKEN_COOKIE = "akai_cart_token";
const CART_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const cartTokenSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/);

/** Fired on `window` after every cart change, so the header count can follow. */
export const CART_CHANGED_EVENT = "akai:cart-changed";

function readCartToken(): string | null {
  const match = /(?:^|;\s*)akai_cart_token=([^;]*)/.exec(document.cookie);
  const parsed = cartTokenSchema.safeParse(match?.[1] === undefined ? undefined : decodeURIComponent(match[1]));
  return parsed.success ? parsed.data : null;
}

function storeCartToken(token: string): void {
  if (!cartTokenSchema.safeParse(token).success) return;
  const secure = location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${CART_TOKEN_COOKIE}=${encodeURIComponent(token)}; path=/; max-age=${String(CART_TOKEN_MAX_AGE_SECONDS)}; samesite=lax${secure}`;
}

function cartTokenHeader(): Record<string, string> {
  const token = readCartToken();
  return token === null ? {} : { [CART_TOKEN_HEADER]: token };
}

export class CartClient {
  constructor(
    private readonly apiUrl: string,
    private readonly locale: Locale,
  ) {}

  private async cartCall(method: HttpMethod, path: string, body?: unknown): Promise<Cart> {
    const { data, headers } = await apiRequest({
      baseUrl: this.apiUrl,
      method,
      path,
      schema: cartSchema,
      query: { locale: this.locale },
      headers: cartTokenHeader(),
      ...(body === undefined ? {} : { body }),
    });
    const issued = headers.get(CART_TOKEN_HEADER);
    if (issued !== null) storeCartToken(issued);
    if (method !== "GET") window.dispatchEvent(new CustomEvent(CART_CHANGED_EVENT, { detail: data }));
    return data;
  }

  /** `null` when this browser has never had a cart — no request is made. */
  async fetch(): Promise<Cart | null> {
    return readCartToken() === null ? null : this.cartCall("GET", "/cart");
  }

  add(variantId: string, quantity: number): Promise<Cart> {
    return this.cartCall("POST", "/cart/items", addCartItemSchema.parse({ variantId, quantity }));
  }

  setQuantity(itemId: string, quantity: number): Promise<Cart> {
    return this.cartCall("PATCH", `/cart/items/${encodeURIComponent(itemId)}`, { quantity });
  }

  remove(itemId: string): Promise<Cart> {
    return this.cartCall("DELETE", `/cart/items/${encodeURIComponent(itemId)}`);
  }

  /** A pack's lines are added and removed together, by pack instance. */
  removePack(packInstanceId: string): Promise<Cart> {
    return this.cartCall("DELETE", `/cart/packs/${encodeURIComponent(packInstanceId)}`);
  }

  async quote(input: z.input<typeof shippingQuoteRequestSchema>) {
    const { data } = await apiRequest({
      baseUrl: this.apiUrl,
      method: "POST",
      path: "/shipping/quote",
      schema: shippingQuoteResponseSchema,
      body: shippingQuoteRequestSchema.parse(input),
      headers: cartTokenHeader(),
    });
    return data;
  }

  /** Creates the order and returns the hosted (Whop) checkout URL to go to. */
  async startCheckout(input: z.input<typeof createCheckoutSessionSchema>, idempotencyKey: string) {
    const { data } = await apiRequest({
      baseUrl: this.apiUrl,
      method: "POST",
      path: "/checkout",
      schema: checkoutSessionResponseSchema,
      body: createCheckoutSessionSchema.parse(input),
      headers: { ...cartTokenHeader(), "idempotency-key": idempotencyKey },
    });
    return data;
  }

  async orderStatus(orderNumber: string) {
    const { data } = await apiRequest({
      baseUrl: this.apiUrl,
      path: `/payments/orders/${encodeURIComponent(orderNumber)}/status`,
      schema: orderStatusResponseSchema,
    });
    return data;
  }
}
