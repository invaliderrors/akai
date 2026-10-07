import { z } from "zod";
import {
  colombianMobileSchema,
  colombianPostalCodeSchema,
  departamentoSchema,
} from "./colombia";
import { isDestinationCountry } from "./destinations";
import { addressTypeSchema, roleSchema } from "./enums";
import {
  countryCodeSchema,
  emailSchema,
  idSchema,
  isoDateTimeSchema,
  localeSchema,
} from "./common";

/**
 * Customer / user identity, sessions and the address book.
 */

/**
 * The customer as the OWNER sees themselves.
 *
 * Note what is absent and must stay absent: passwordHash, totpSecret, recovery
 * codes, refresh-token families. This schema is what the API serialises, so a
 * field that is not here cannot leak through a careless `res.json(customer)`.
 */
export const customerSchema = z
  .object({
    id: idSchema,
    email: emailSchema,
    emailVerifiedAt: isoDateTimeSchema.nullable(),
    firstName: z.string().min(1).max(80).nullable(),
    lastName: z.string().min(1).max(80).nullable(),
    phone: z.string().max(32).nullable(),
    role: roleSchema,
    preferredLocale: localeSchema,
    /** True once TOTP is enrolled. Mandatory for ADMIN (spec §8). */
    twoFactorEnabled: z.boolean(),
    /** Set when the customer exercised erasure; the row is anonymised, never deleted. */
    anonymisedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type Customer = z.infer<typeof customerSchema>;

/**
 * The ADMIN-facing view of a customer. Superset of the self view.
 * Kept as a distinct schema so an admin-only field can never be added to the
 * customer view by editing one object.
 */
export const adminCustomerSchema = customerSchema
  .extend({
    orderCount: z.number().int().min(0),
    /** Lifetime value in minor units of the store's base currency. */
    lifetimeValueMinor: z.number().int().min(0),
    lastOrderAt: isoDateTimeSchema.nullable(),
    marketingConsentAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type AdminCustomer = z.infer<typeof adminCustomerSchema>;

/** A live login session, listed in the dashboard's security page. */
export const sessionSchema = z
  .object({
    id: idSchema,
    createdAt: isoDateTimeSchema,
    lastSeenAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    ipAddress: z.string().max(45).nullable(),
    userAgent: z.string().max(512).nullable(),
    /** Lets the UI mark "this device" without exposing any token material. */
    isCurrent: z.boolean(),
  })
  .strict();

export type Session = z.infer<typeof sessionSchema>;

/**
 * Address fields shared by the address book and the ORDER SNAPSHOT.
 *
 * Orders copy these values into their own columns rather than holding an FK
 * (spec §13): if a customer edits their address next year, a shipped order's
 * historical record must not silently rewrite itself.
 *
 * COLOMBIAN SHAPE — Colombia is the only country served:
 *  - `countryCode` must be a destination (`DESTINATION_COUNTRY_CODES`: "CO").
 *  - `region` is the DEPARTAMENTO, required, normalised to its canonical name
 *    from `COLOMBIAN_DEPARTAMENTOS` (a DANE code or a loosely-typed name is
 *    accepted and rewritten).
 *  - `city` is the municipio, free text.
 *  - `line1` carries the street AND number the Colombian way
 *    ("Calle 10 # 43-21"); `line2` the apartment, tower or neighbourhood.
 *  - `postalCode` is optional (rarely used in Colombia); six digits when given.
 *  - `phone`, when present, is a Colombian mobile normalised to 10 digits
 *    without +57. Checkout requires it (`checkoutShippingAddressSchema`).
 */
export const addressFieldsSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    company: z.string().max(120).nullable(),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().max(200).nullable(),
    city: z.string().trim().min(1).max(120),
    region: departamentoSchema,
    postalCode: colombianPostalCodeSchema.nullable().default(null),
    countryCode: countryCodeSchema.refine((code): boolean => isDestinationCountry(code), {
      message: "countryCode must be a country the store ships to (CO)",
    }),
    phone: colombianMobileSchema.nullable(),
  })
  .strict();

export type AddressFields = z.infer<typeof addressFieldsSchema>;

/** A saved address-book entry. */
export const addressSchema = addressFieldsSchema
  .extend({
    id: idSchema,
    customerId: idSchema,
    type: addressTypeSchema,
    isDefault: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type Address = z.infer<typeof addressSchema>;

export const createAddressSchema = addressFieldsSchema
  .extend({
    type: addressTypeSchema,
    isDefault: z.boolean().default(false),
  })
  .strict();

export type CreateAddress = z.infer<typeof createAddressSchema>;

/** PATCH semantics: every field optional, unknown fields rejected. */
export const updateAddressSchema = createAddressSchema.partial().strict();
export type UpdateAddress = z.infer<typeof updateAddressSchema>;

// ---------------------------------------------------------------------------
// Auth request/response shapes
// ---------------------------------------------------------------------------

/**
 * Password policy lives here so the API, the dashboard's client-side hint and
 * the tests agree. Length beats composition rules: an 12-char passphrase
 * outlives "must contain a symbol" every time.
 */
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(200, "Password must be at most 200 characters");

export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    preferredLocale: localeSchema.default("es"),
    /** Bot protection: verified server-side against Turnstile. */
    turnstileToken: z.string().min(1),
    marketingConsent: z.boolean().default(false),
  })
  .strict();

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1),
    /** Present only on the second leg of a 2FA login. */
    totpCode: z.string().length(6).optional(),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Login result.
 *
 * There are deliberately NO TOKENS in this shape. Tokens are held server-side
 * by the dashboard's BFF route handlers, which set a single httpOnly
 * `akai_session` cookie (spec §8). Putting an access token in a JSON body is
 * how it ends up in localStorage and then in an XSS payload.
 */
export const loginResponseSchema = z
  .object({
    customer: customerSchema,
    /** When true the client must collect a TOTP code and call login again. */
    requiresTwoFactor: z.boolean(),
  })
  .strict();

export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * EMAILED ONE-TIME SIGN-IN CODES.
 *
 * Two shapes rather than one, because the two legs have nothing in common but
 * the address: requesting a code sends mail (so it is captcha-gated like every
 * other mail-sending route) and answers neutrally; verifying one is an
 * authentication attempt that returns a session.
 */
export const requestLoginCodeSchema = z
  .object({
    email: emailSchema,
    /** Bot protection: this route sends mail to an address the caller names. */
    turnstileToken: z.string().min(1),
  })
  .strict();

export type RequestLoginCode = z.infer<typeof requestLoginCodeSchema>;

/**
 * THE FIELD IS `loginCode`, NEVER `code`.
 *
 * `totpCode` above is already `z.string().length(6)`, and an account with TOTP
 * enrolled has to send BOTH in this one body. Two six-digit fields of identical
 * shape called `code` and `totpCode` is a confusion hazard for the UI, for the
 * server branch that reads them and for anyone reading a log line — and the two
 * are not interchangeable: one is a mailed bearer credential, the other proves
 * possession of a device.
 */
export const verifyLoginCodeSchema = z
  .object({
    email: emailSchema,
    loginCode: z.string().regex(/^\d{6}$/, "A sign-in code is exactly six digits"),
    /** Present only when the account has TOTP enrolled — the gate still applies. */
    totpCode: z.string().length(6).optional(),
  })
  .strict();

export type VerifyLoginCode = z.infer<typeof verifyLoginCodeSchema>;

export const requestPasswordResetSchema = z
  .object({
    email: emailSchema,
    turnstileToken: z.string().min(1),
  })
  .strict();

export const confirmPasswordResetSchema = z
  .object({
    token: z.string().min(1),
    password: passwordSchema,
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
  })
  .strict();

export const verifyEmailSchema = z.object({ token: z.string().min(1) }).strict();
