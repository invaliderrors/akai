import {
  type Address,
  type CreateReturnRequest,
  type Customer,
  type Order,
  type OrderSummary,
  type Paginated,
  type Payment,
  type ReturnRequest,
  type OrderShipment,
  addressSchema,
  createAddressSchema,
  createReturnRequestSchema,
  customerSchema,
  orderSchema,
  orderSummarySchema,
  paginatedReturnsSchema,
  paginatedSchema,
  paymentSchema,
  returnRequestSchema,
  updateAddressSchema,
} from "@akai/contracts";
import { z } from "zod";
import type { ServerApiClient } from "@/lib/api/client";
import type { ApiResult } from "@/lib/api/errors";

/**
 * The typed customer-account API.
 *
 * A thin, named layer over the shared `ServerApiClient` (owned by the auth
 * shell). It adds exactly two things and deliberately nothing else:
 *
 *   1. It binds each endpoint to its `@akai/contracts` response schema, so a
 *      caller cannot accidentally parse an order list with an address schema.
 *   2. It names the account operations, so a page reads `api.listOrders()`
 *      rather than a bare path string that no compiler checks for typos.
 *
 * Everything else — bearer token, request id, no-store caching, envelope
 * decoding — belongs to the shared client and is not reimplemented here.
 *
 * RESULTS, NOT EXCEPTIONS. Every method returns `ApiResult<T>`, matching the
 * shared client. An API 404 on an order is an ordinary outcome the UI renders,
 * not an exception; making it a return value means the compiler forces each
 * caller to handle it, which `throw` cannot do.
 *
 * REQUESTS ARE STRICT, RESPONSES ARE TOLERANT. Request schemas are `.strict()`
 * because an unknown key is our bug and should fail before the wire. Response
 * schemas use `.passthrough()` where forward-compatibility matters: a server
 * that starts sending a NEW field must not break an already-deployed dashboard.
 */

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * Derived from `customerSchema` with `.pick()` rather than redeclared, so the
 * field types cannot drift from the entity they update. Mirrors the API's
 * `updateProfileSchema`; `email` and `role` are deliberately absent — changing
 * an email is an identity operation that must re-verify, and a self-service
 * role change is privilege escalation.
 */
export const updateProfileRequestSchema = customerSchema
  .pick({ firstName: true, lastName: true, phone: true, preferredLocale: true })
  .partial()
  .strict();

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

export const createAddressRequestSchema = createAddressSchema;
export type CreateAddressRequest = z.infer<typeof createAddressRequestSchema>;

export const updateAddressRequestSchema = updateAddressSchema;
export type UpdateAddressRequest = z.infer<typeof updateAddressRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(12).max(200),
  })
  .strict();

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const orderListResponseSchema = paginatedSchema(orderSummarySchema);
const addressListResponseSchema = z.array(addressSchema);

/**
 * The order-detail payload.
 *
 * `GET /orders/:orderNumber` returns `orderSchema`, which now CARRIES the
 * order's parcels (`order.shipments`, the customer-safe `orderShipmentSchema`
 * shape — Sendcloud spec §5) and defaults them to `[]` for an older API. They
 * are read from there; the old `shipments: shipmentSchema[]` override is gone,
 * because the full `shipmentSchema` (order id, line split) is not what the
 * customer endpoint sends and would have rejected it.
 *
 * `payment` is still OPTIONAL: the API does not send it yet, and the page
 * renders it automatically the moment the mapper includes it.
 *
 * `.passthrough()` is load-bearing, not stylistic: `orderSchema` is `.strict()`,
 * so once the API does send `payment`, a strict parse would reject the very
 * response we asked it for.
 */
const orderDetailResponseSchema = orderSchema
  .extend({
    payment: paymentSchema.nullish(),
  })
  .passthrough()
  .transform((raw): OrderDetail => {
    // Re-parse the order half strictly so `OrderDetail.order` is exactly an
    // `Order` and does not carry the passthrough index signature outward.
    const order: Order = orderSchema.passthrough().parse(raw);
    return {
      order,
      shipments: order.shipments,
      payment: raw.payment ?? null,
    };
  });

export interface OrderDetail {
  readonly order: Order;
  readonly shipments: readonly OrderShipment[];
  /** Null when no payment has been attempted, or when the API omits it. */
  readonly payment: Payment | null;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface OrderListQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AccountApi {
  getProfile(): Promise<ApiResult<Customer>>;
  updateProfile(input: UpdateProfileRequest): Promise<ApiResult<Customer>>;
  listOrders(query?: OrderListQuery): Promise<ApiResult<Paginated<OrderSummary>>>;
  getOrder(orderNumber: string): Promise<ApiResult<OrderDetail>>;
  listAddresses(): Promise<ApiResult<readonly Address[]>>;
  createAddress(input: CreateAddressRequest): Promise<ApiResult<Address>>;
  updateAddress(
    addressId: string,
    input: UpdateAddressRequest,
  ): Promise<ApiResult<Address>>;
  deleteAddress(addressId: string): Promise<ApiResult<undefined>>;
  changePassword(input: ChangePasswordRequest): Promise<ApiResult<undefined>>;
  /** The caller's own return requests, newest first. */
  listReturns(): Promise<ApiResult<Paginated<ReturnRequest>>>;
  /** Raise a return against one of the caller's delivered orders. */
  requestReturn(input: CreateReturnRequest): Promise<ApiResult<ReturnRequest>>;
}

/**
 * Build the query string for the order list.
 *
 * Undefined values are DROPPED rather than stringified. `?cursor=undefined` is a
 * real bug class: the server sees a present-but-nonsense cursor and either 400s
 * or, worse, silently returns page one forever.
 */
function orderListPath(query: OrderListQuery | undefined): string {
  const params = new URLSearchParams();
  if (query?.cursor !== undefined) {
    params.set("cursor", query.cursor);
  }
  if (query?.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  const suffix = params.toString();
  return suffix === "" ? "/orders" : `/orders?${suffix}`;
}

/**
 * Every mutating method is `async` even where the body is a one-liner.
 *
 * That is not stylistic. The request-schema `.parse()` throws on a malformed
 * argument, and from a NON-async function declared to return a Promise it would
 * throw SYNCHRONOUSLY — sailing straight past the caller's `.catch()` and past
 * any `try` that only awaits. `async` guarantees the failure arrives as a
 * rejection, which is the one thing every caller is already prepared for.
 *
 * (A thrown parse error means our own code built a bad request, i.e. a bug. It
 * is deliberately NOT folded into `ApiResult`, which models outcomes the server
 * legitimately produces and the UI is expected to render.)
 */
export function createAccountApi(client: ServerApiClient): AccountApi {
  return {
    async getProfile() {
      return client.get("/me", customerSchema);
    },

    async updateProfile(input) {
      // Parsed before the wire so an unknown or malformed field fails here,
      // with a stack pointing at the caller, rather than as a 400 from the API.
      const body = updateProfileRequestSchema.parse(input);
      return client.patch("/me", customerSchema, body);
    },

    async listOrders(query) {
      return client.get(orderListPath(query), orderListResponseSchema);
    },

    async getOrder(orderNumber) {
      return client.get(
        `/orders/${encodeURIComponent(orderNumber)}`,
        orderDetailResponseSchema,
      );
    },

    async listReturns() {
      return client.get("/returns", paginatedReturnsSchema);
    },

    async requestReturn(input) {
      // Parsed before it leaves, so a malformed call fails here with a field
      // path rather than as a 400 the page has to translate.
      const body = createReturnRequestSchema.parse(input);
      return client.post("/returns", returnRequestSchema, body);
    },

    async listAddresses() {
      return client.get("/me/addresses", addressListResponseSchema);
    },

    async createAddress(input) {
      const body = createAddressRequestSchema.parse(input);
      return client.post("/me/addresses", addressSchema, body);
    },

    async updateAddress(addressId, input) {
      const body = updateAddressRequestSchema.parse(input);
      return client.patch(
        `/me/addresses/${encodeURIComponent(addressId)}`,
        addressSchema,
        body,
      );
    },

    async deleteAddress(addressId) {
      // 204 with no body — `z.undefined()` is how the shared client expresses
      // "there is legitimately nothing to parse".
      return client.delete(
        `/me/addresses/${encodeURIComponent(addressId)}`,
        z.undefined(),
      );
    },

    async changePassword(input) {
      const body = changePasswordRequestSchema.parse(input);
      return client.post("/auth/password/change", z.undefined(), body);
    },
  };
}
