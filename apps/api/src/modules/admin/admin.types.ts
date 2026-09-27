import { z } from "zod";
import { roleSchema, type Role } from "@akai/contracts";

/**
 * Types and PORTS for the admin surface.
 *
 * Everything in this file that describes another module's territory is declared
 * as an INTERFACE + injection token, never as a concrete import. The catalog,
 * auth, audit and idempotency modules are placeholders at the time this module
 * was written (parallel agents own them), so binding to their internals would
 * either block on them or fork their logic. A port is the only way to depend on
 * a module that does not exist yet without duplicating it.
 *
 * At integration, each token below is rebound to the real provider. No code in
 * this module changes when that happens — that is the point.
 */

// ---------------------------------------------------------------------------
// Actor / principal
// ---------------------------------------------------------------------------

/**
 * What an upstream JwtAuthGuard is expected to leave on the request.
 *
 * NOTE the absence of `role`. The access token carries one (spec §8), but this
 * module deliberately does not read it: a token minted before a demotion still
 * says ADMIN. The role is re-read from the DB session row on every request.
 */
export interface AdminPrincipal {
  readonly sub: string;
  readonly sessionId: string;
}

/**
 * The verified actor, assembled by AdminGuard AFTER the DB re-read.
 * This — not the token — is what every admin handler and audit row uses.
 */
export interface AdminActor {
  readonly customerId: string;
  readonly sessionId: string;
  readonly role: Role;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
}

/**
 * Narrow the principal JwtAuthGuard attached into this module's shape.
 *
 * Written as a type guard over `unknown` rather than a cast because the value is
 * placed on the request by framework code TypeScript cannot verify. A cast here
 * would mean a malformed or absent principal sails through the guard and
 * produces `undefined` where a customer id is expected.
 *
 * `customerId`, not `sub`. This originally parsed a raw JWT payload off
 * `request.user`, because AuthModule was a placeholder when it was written.
 * AuthModule now owns the principal and publishes it under
 * PRINCIPAL_REQUEST_KEY with `customerId` as the identity field — so the old
 * shape matched nothing and this guard would have refused every admin request
 * with 401. Fail-closed, but uniformly broken, and no test in this module could
 * see it: they all constructed the request object themselves.
 */
const principalSchema = z
  .object({
    customerId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  // NOT .strict(): the principal legitimately carries other fields (role,
  // twoFactorAssertedAt). We assert what we rely on and ignore the rest —
  // unlike a request body, this object is minted by our own auth layer.
  .passthrough();

export function narrowPrincipal(value: unknown): AdminPrincipal | null {
  const parsed = principalSchema.safeParse(value);
  return parsed.success
    ? { sub: parsed.data.customerId, sessionId: parsed.data.sessionId }
    : null;
}

const actorSchema = z
  .object({
    customerId: z.string().min(1),
    sessionId: z.string().min(1),
    role: roleSchema,
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    requestId: z.string(),
  })
  .strict();

/**
 * Narrow an unknown request property into a verified actor.
 *
 * Exists so the `@CurrentAdmin()` param decorator never has to cast. The actor
 * is attached by AdminGuard, but the request object is typed as `unknown` at
 * that boundary, and a cast would let a handler run with a half-formed actor if
 * the guard were ever reordered or replaced.
 */
export function narrowAdminActor(value: unknown): AdminActor | null {
  const parsed = actorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Session reader port (owned by AuthModule after integration)
// ---------------------------------------------------------------------------

export interface AdminSessionSnapshot {
  readonly sessionId: string;
  readonly customerId: string;
  /** Read from the customer row, live. Never from the token. */
  readonly role: Role;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
  /** Spec §8: admin routes require a FRESH 2FA assertion recorded here. */
  readonly twoFactorAssertedAt: Date | null;
}

export interface AdminSessionReader {
  findActiveSession(sessionId: string): Promise<AdminSessionSnapshot | null>;
}

export const ADMIN_SESSION_READER = Symbol("ADMIN_SESSION_READER");

// ---------------------------------------------------------------------------
// Catalog port (owned by CatalogModule) — admin does NOT reimplement product CRUD
// ---------------------------------------------------------------------------

/**
 * One product as it crosses the bulk import/export boundary.
 *
 * Intentionally the slug-keyed projection rather than the full `Product` from
 * @akai/contracts: an export file must be re-importable into a DIFFERENT
 * environment (staging → production), where internal UUIDs do not exist. The
 * slug is the stable natural key across environments; an id is not.
 */
export interface ExportedProductRow {
  readonly slug: string;
  readonly status: string;
  readonly taxClass: string;
  readonly translations: readonly {
    readonly locale: string;
    readonly name: string;
    readonly shortDescription: string;
    readonly description: string;
  }[];
  readonly variants: readonly {
    readonly sku: string;
    readonly priceGross: number;
    readonly compareAtGross: number | null;
    readonly currency: string;
    readonly weightGrams: number | null;
    readonly lowStockThreshold: number;
    readonly allowBackorder: boolean;
  }[];
  readonly restrictedCountries: readonly string[];
}

/** The shape the admin bulk importer hands to the catalog module. */
export interface UpsertProductInput {
  readonly slug: string;
  readonly status: string;
  readonly taxClass: string;
  readonly translations: readonly {
    readonly locale: string;
    readonly name: string;
    readonly shortDescription: string;
    readonly description: string;
  }[];
  readonly variants: readonly {
    readonly sku: string;
    readonly priceGross: number;
    readonly compareAtGross: number | null;
    readonly currency: string;
    readonly weightGrams: number | null;
    readonly initialStock: number;
    readonly lowStockThreshold: number;
    readonly allowBackorder: boolean;
  }[];
  readonly restrictedCountries: readonly string[];
}

export interface UpsertProductResult {
  readonly id: string;
  readonly slug: string;
  readonly created: boolean;
  /** Pre-change state, null on create. Feeds the audit `before` snapshot. */
  readonly previous: ExportedProductRow | null;
}

/**
 * The catalog operations the admin surface consumes.
 *
 * Deliberately NARROW: admin composes and audits, catalog owns the writes. If
 * this interface starts growing product-shaped business rules, that logic
 * belongs in CatalogModule, not here.
 */
export interface CatalogAdminPort {
  exportProducts(): Promise<readonly ExportedProductRow[]>;
  upsertProduct(input: UpsertProductInput): Promise<UpsertProductResult>;
}

export const CATALOG_ADMIN_PORT = Symbol("CATALOG_ADMIN_PORT");
