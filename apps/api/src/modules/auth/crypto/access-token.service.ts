import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { roleSchema } from "@akai/contracts";
import { CLOCK, type Clock } from "../ports/clock.port";

/**
 * HS512 access tokens, implemented directly on `node:crypto`.
 *
 * Hand-rolling JWT is normally a bad idea, so the reasoning is worth stating.
 * Essentially every historical JWT vulnerability comes from a library being
 * FLEXIBLE: `alg: none` accepted, RS256 tokens verified as HS256 with the
 * public key used as an HMAC secret, `kid` used for path traversal. Those are
 * all consequences of letting the TOKEN choose how it gets verified.
 *
 * This implementation cannot express any of them. There is exactly one
 * algorithm, one key, and one code path. The `alg` header is compared against
 * the expected constant and is never consulted to select a key or a primitive —
 * even if that check were removed, verification would still be HMAC-SHA512 with
 * the configured secret. Combined with the fact that no JWT library is a
 * workspace dependency yet, this is the smaller risk.
 *
 * Everything below the signature is parsed with zod, so a token that verifies
 * but carries a malformed payload is rejected as firmly as one that does not
 * verify at all.
 */

export interface AccessTokenOptions {
  /** HS512 signing key. At least 32 chars, enforced by the config schema. */
  readonly secret: string;
  readonly ttlMs: number;
  readonly issuer: string;
  readonly audience: string;
  /**
   * Tolerance for clock skew between the signer and verifier, in seconds.
   * Small and explicit: a large window extends the life of a revoked token.
   */
  readonly clockToleranceSeconds: number;
}

export const ACCESS_TOKEN_OPTIONS = Symbol("ACCESS_TOKEN_OPTIONS");

const ALGORITHM = "HS512" as const;
const HMAC_ALGORITHM = "sha512" as const;
const TOKEN_TYPE = "JWT" as const;

const headerSchema = z
  .object({
    alg: z.literal(ALGORITHM),
    typ: z.literal(TOKEN_TYPE),
  })
  .strict();

/**
 * The claim set.
 *
 * `.strict()` means an attacker cannot append claims to a payload they somehow
 * influenced. `role` is present for logging and metrics ONLY — spec §8 requires
 * authorisation to re-read the role from the session row on every request, and
 * JwtAuthGuard does exactly that. Trusting this claim would make a role
 * revocation take up to the full access-token TTL to bite.
 */
const accessTokenPayloadSchema = z
  .object({
    sub: z.string().uuid(),
    sessionId: z.string().uuid(),
    role: roleSchema,
    /** Unique per token, so a specific token can be denylisted if ever needed. */
    jti: z.string().uuid(),
    iss: z.string().min(1),
    aud: z.string().min(1),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
  })
  .strict();

export type AccessTokenPayload = z.infer<typeof accessTokenPayloadSchema>;

export interface IssueAccessTokenInput {
  readonly customerId: string;
  readonly sessionId: string;
  readonly role: z.infer<typeof roleSchema>;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
  readonly jti: string;
}

/** Why a token was rejected. Never surfaced to the client — logs only. */
export type AccessTokenFailure =
  | "malformed"
  | "bad-signature"
  | "bad-header"
  | "bad-payload"
  | "expired"
  | "not-yet-valid"
  | "wrong-issuer"
  | "wrong-audience";

export type AccessTokenVerification =
  | { readonly ok: true; readonly payload: AccessTokenPayload }
  | { readonly ok: false; readonly reason: AccessTokenFailure };

function base64UrlEncode(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input, "utf8") : input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Strict base64url decode.
 *
 * Node's base64 decoder is lenient — it silently ignores characters outside the
 * alphabet — which means two DIFFERENT token strings can decode to the same
 * bytes. Rejecting anything that is not canonical base64url closes that
 * malleability, so a signature covers exactly one representation.
 */
function base64UrlDecode(input: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    return null;
  }
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(padded, "base64");
  if (base64UrlEncode(decoded) !== input) {
    return null;
  }
  return decoded;
}

function parseJsonObject(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

@Injectable()
export class AccessTokenService {
  constructor(
    @Inject(ACCESS_TOKEN_OPTIONS) private readonly options: AccessTokenOptions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  issue(input: IssueAccessTokenInput): IssuedAccessToken {
    const now = this.clock.now();
    const issuedAtSeconds = Math.floor(now.getTime() / 1000);
    const expiresAt = new Date(now.getTime() + this.options.ttlMs);
    const jti = randomUUID();

    const payload: AccessTokenPayload = {
      sub: input.customerId,
      sessionId: input.sessionId,
      role: input.role,
      jti,
      iss: this.options.issuer,
      aud: this.options.audience,
      iat: issuedAtSeconds,
      exp: Math.floor(expiresAt.getTime() / 1000),
    };

    const header = base64UrlEncode(JSON.stringify({ alg: ALGORITHM, typ: TOKEN_TYPE }));
    const body = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${header}.${body}`;

    return {
      token: `${signingInput}.${this.sign(signingInput)}`,
      expiresAt,
      jti,
    };
  }

  verify(token: string): AccessTokenVerification {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { ok: false, reason: "malformed" };
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined ||
      encodedHeader.length === 0 ||
      encodedPayload.length === 0 ||
      encodedSignature.length === 0
    ) {
      return { ok: false, reason: "malformed" };
    }

    // SIGNATURE FIRST, always. Nothing from the payload is interpreted — not
    // even to decide how to verify it — until the MAC has been checked.
    if (!this.signatureMatches(`${encodedHeader}.${encodedPayload}`, encodedSignature)) {
      return { ok: false, reason: "bad-signature" };
    }

    const headerBytes = base64UrlDecode(encodedHeader);
    if (headerBytes === null) {
      return { ok: false, reason: "malformed" };
    }
    if (!headerSchema.safeParse(parseJsonObject(headerBytes)).success) {
      // Unreachable in practice, since a mismatched header changes the signing
      // input and would already have failed the MAC. Kept as an explicit
      // assertion that `alg: none` and algorithm substitution are rejected.
      return { ok: false, reason: "bad-header" };
    }

    const payloadBytes = base64UrlDecode(encodedPayload);
    if (payloadBytes === null) {
      return { ok: false, reason: "malformed" };
    }

    const parsed = accessTokenPayloadSchema.safeParse(parseJsonObject(payloadBytes));
    if (!parsed.success) {
      return { ok: false, reason: "bad-payload" };
    }
    const payload = parsed.data;

    if (payload.iss !== this.options.issuer) {
      return { ok: false, reason: "wrong-issuer" };
    }
    // Prevents a token minted for another audience (e.g. a future internal
    // service sharing the secret) being replayed against this API.
    if (payload.aud !== this.options.audience) {
      return { ok: false, reason: "wrong-audience" };
    }

    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    const tolerance = this.options.clockToleranceSeconds;

    if (payload.exp + tolerance <= nowSeconds) {
      return { ok: false, reason: "expired" };
    }
    if (payload.iat - tolerance > nowSeconds) {
      return { ok: false, reason: "not-yet-valid" };
    }

    return { ok: true, payload };
  }

  private sign(signingInput: string): string {
    return base64UrlEncode(
      createHmac(HMAC_ALGORITHM, this.options.secret).update(signingInput).digest(),
    );
  }

  private signatureMatches(signingInput: string, provided: string): boolean {
    const expected = Buffer.from(this.sign(signingInput), "utf8");
    const actual = Buffer.from(provided, "utf8");

    // timingSafeEqual throws on a length mismatch, which would itself be a
    // timing signal, so the length check is done first and deliberately.
    if (expected.length !== actual.length) {
      return false;
    }
    return timingSafeEqual(expected, actual);
  }
}
