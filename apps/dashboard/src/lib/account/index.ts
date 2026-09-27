/**
 * The customer-account data layer.
 *
 * A named, schema-bound facade over the shared `ServerApiClient` in
 * `@/lib/api/client` (owned by the auth shell). Transport, auth headers and
 * error-envelope decoding live there; only endpoint-to-schema binding lives
 * here.
 */

export {
  createAccountApi,
  changePasswordRequestSchema,
  createAddressRequestSchema,
  updateAddressRequestSchema,
  updateProfileRequestSchema,
  type AccountApi,
  type ChangePasswordRequest,
  type CreateAddressRequest,
  type OrderDetail,
  type OrderListQuery,
  type UpdateAddressRequest,
  type UpdateProfileRequest,
} from "./account-api";
