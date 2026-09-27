import { z } from "zod";
import {
  addressSchema,
  addressTypeSchema,
  customerSchema,
  emailSchema,
  idSchema,
  isoDateTimeSchema,
  localeSchema,
  paginationQuerySchema,
  roleSchema,
} from "@akai/contracts";

/**
 * Request/response schemas for UsersModule.
 *
 * Everything reusable already lives in @akai/contracts and is imported, not
 * redeclared. What is declared here is only what is specific to this module's
 * endpoints. When the ts-rest routers land these move into
 * `libs/contracts/src/lib/users.contract.ts` unchanged (see followUps).
 */

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * PATCH /me.
 *
 * Note what is deliberately ABSENT and must stay absent:
 *
 * - `email`   — changing it re-keys the account's identity and must go through
 *               a verify-new-address flow owned by AuthModule. Allowing it here
 *               would let an attacker with a stolen session lock the real owner
 *               out by moving the address, then trigger a password reset to it.
 * - `role`    — privilege escalation in one PATCH.
 * - `anonymisedAt`, `emailVerifiedAt` — server-owned lifecycle facts.
 *
 * `.strict()` means these are rejected rather than ignored, so an attempt shows
 * up as a 400 in the logs instead of a silent no-op nobody notices.
 */
export const updateProfileSchema = z
  .object({
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    phone: z.string().max(32).nullable(),
    preferredLocale: localeSchema,
  })
  .partial()
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

// ---------------------------------------------------------------------------
// Address book
// ---------------------------------------------------------------------------

/**
 * Address create/update.
 *
 * Redeclared rather than imported from contracts' `createAddressSchema` for one
 * reason: `isDefault` must be OPTIONAL here, not defaulted to false. "Absent"
 * and "explicitly false" are different instructions to this module — absent lets
 * the service promote a first-of-its-type address to default automatically,
 * while an explicit false is a request that is refused when it would leave the
 * customer with no default at all.
 */
export const createAddressRequestSchema = z
  .object({
    type: addressTypeSchema,
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    company: z.string().max(120).nullable().default(null),
    line1: z.string().min(1).max(200),
    line2: z.string().max(200).nullable().default(null),
    city: z.string().min(1).max(120),
    region: z.string().max(120).nullable().default(null),
    postalCode: z.string().min(1).max(20),
    countryCode: z
      .string()
      .length(2)
      .regex(/^[A-Z]{2}$/, "Country must be an uppercase ISO-3166-1 alpha-2 code"),
    phone: z.string().max(32).nullable().default(null),
    isDefault: z.boolean().optional(),
  })
  .strict();

export type CreateAddressInput = z.infer<typeof createAddressRequestSchema>;

export const updateAddressRequestSchema = createAddressRequestSchema.partial().strict();

export type UpdateAddressInput = z.infer<typeof updateAddressRequestSchema>;

// ---------------------------------------------------------------------------
// Admin listing
// ---------------------------------------------------------------------------

/**
 * GET /admin/users query.
 *
 * Cursor pagination only (contracts' `paginationQuerySchema`) — see the note
 * there on why OFFSET is not offered.
 *
 * `anonymised` arrives as a query STRING, so it is coerced explicitly rather
 * than with `z.coerce.boolean()`, which is a truthiness cast: `"false"` is a
 * non-empty string and would coerce to `true`, inverting the filter.
 */
export const adminUserListQuerySchema = paginationQuerySchema
  .extend({
    /** Case-insensitive substring match against the citext email column. */
    email: z.string().min(1).max(254).optional(),
    role: roleSchema.optional(),
    anonymised: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    createdAfter: isoDateTimeSchema.optional(),
    createdBefore: isoDateTimeSchema.optional(),
  })
  .strict();

export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/**
 * POST /me/delete.
 *
 * Requires the caller to retype their own email. Erasure is irreversible and
 * cannot be undone by support, so a single mis-click must not be sufficient.
 */
export const erasureRequestSchema = z
  .object({
    confirmEmail: emailSchema,
    reason: z.string().max(500).optional(),
  })
  .strict();

export type ErasureRequestInput = z.infer<typeof erasureRequestSchema>;

export const erasureResultSchema = z
  .object({
    anonymisedAt: isoDateTimeSchema,
    /**
     * Orders are NOT erased. EU invoice retention runs 7-10 years, which is a
     * legal obligation under GDPR Art. 17(3)(b) and overrides the erasure
     * request. Reporting the count makes that explicit to the customer rather
     * than leaving them believing everything was destroyed.
     */
    ordersRetained: z.number().int().min(0),
    addressesErased: z.number().int().min(0),
    sessionsRevoked: z.number().int().min(0),
  })
  .strict();

export type ErasureResult = z.infer<typeof erasureResultSchema>;

// ---------------------------------------------------------------------------
// GDPR export (Art. 20, portability)
// ---------------------------------------------------------------------------

/**
 * The portable export. Art. 20 requires a "structured, commonly used,
 * machine-readable format" — this schema IS that contract, and validating the
 * payload on the way out means a future column addition cannot silently start
 * exporting a field nobody reviewed for disclosure.
 */
export const personalDataExportSchema = z
  .object({
    generatedAt: isoDateTimeSchema,
    formatVersion: z.literal(1),
    profile: customerSchema,
    addresses: z.array(addressSchema),
    orders: z.array(
      z
        .object({
          orderNumber: z.string(),
          status: z.string(),
          currency: z.string(),
          /** Minor units, integer. Never a float, never a formatted string. */
          grandTotal: z.number().int(),
          placedAt: isoDateTimeSchema,
          invoiceNumber: z.string().nullable(),
        })
        .strict(),
    ),
    consents: z.array(
      z
        .object({
          kind: z.string(),
          version: z.string(),
          granted: z.boolean(),
          recordedAt: isoDateTimeSchema,
        })
        .strict(),
    ),
    emails: z.array(
      z
        .object({
          templateKey: z.string(),
          status: z.string(),
          sentAt: isoDateTimeSchema.nullable(),
        })
        .strict(),
    ),
    sessions: z.array(
      z
        .object({
          id: idSchema,
          createdAt: isoDateTimeSchema,
          lastSeenAt: isoDateTimeSchema,
          ipAddress: z.string().nullable(),
          userAgent: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type PersonalDataExport = z.infer<typeof personalDataExportSchema>;
