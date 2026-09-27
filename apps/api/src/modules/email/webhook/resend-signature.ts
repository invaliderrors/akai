import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Resend webhook signature verification.
 *
 * Resend signs with SVIX, which is the same FAMILY as the Whop webhook (both are
 * Standard Webhooks: `${id}.${timestamp}.${rawBody}`, HMAC-SHA256, base64, a
 * five-minute tolerance) — but the two are verified by different code for two
 * concrete reasons, and this is ours because Resend ships no verifier we can call.
 *
 * THREE DETAILS THAT ARE NOT SHARED, each of which silently breaks verification:
 *
 *  - The secret is base64 behind a `whsec_` prefix and the HMAC key is the
 *    DECODED bytes. Whop is the mirror image: it signs with the LITERAL bytes of
 *    its `ws_` secret, so the SDK helper base64-ENCODES before handing the key to
 *    the same library. Applying either convention to the other provider produces
 *    a key that verifies nothing.
 *  - `svix-signature` carries a SPACE-SEPARATED LIST of `v1,<base64>` entries,
 *    because Svix supports key rotation — during a rotation two signatures are
 *    sent and only one matches. Reading the header as a single value breaks
 *    silently, and only while a rotation is in progress.
 *  - The header names are `svix-*`, not `webhook-*`.
 *
 * The timestamp is inside the signed content and is checked against a tolerance,
 * which is what bounds replay: the signature over a captured delivery stays valid
 * forever otherwise.
 */

const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1";

/** Svix's own default. Wide enough for clock skew, narrow enough to bound replay. */
export const RESEND_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export const RESEND_ID_HEADER = "svix-id";
export const RESEND_TIMESTAMP_HEADER = "svix-timestamp";
export const RESEND_SIGNATURE_HEADER = "svix-signature";

export interface ResendSignatureHeaders {
  readonly id: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
}

/**
 * The HMAC key: the base64 payload of the secret, decoded.
 *
 * A secret WITHOUT the prefix is accepted as raw base64 — Svix's own libraries do
 * the same, and an operator who pasted the value without its prefix should get a
 * working verifier rather than a silent mismatch.
 */
function secretKey(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return Buffer.from(encoded, "base64");
}

/** `${id}.${timestamp}.${body}` — exactly what Svix signs. */
function signedContent(id: string, timestamp: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${id}.${timestamp}.`, "utf8"), rawBody]);
}

/** Signs a body exactly as Resend does. Lives beside the verifier so they cannot drift. */
export function signResendBody(
  rawBody: Buffer,
  headers: { readonly id: string; readonly timestamp: string },
  secret: string,
): string {
  const digest = createHmac("sha256", secretKey(secret))
    .update(signedContent(headers.id, headers.timestamp, rawBody))
    .digest("base64");
  return `${SIGNATURE_VERSION},${digest}`;
}

/**
 * True when the delivery is authentic and recent.
 *
 * `now` is injected rather than read from the clock so the tolerance is testable
 * without waiting or faking global time.
 */
export function verifyResendSignature(
  rawBody: Buffer,
  headers: ResendSignatureHeaders,
  secret: string,
  now: Date,
): boolean {
  const { id, timestamp, signature } = headers;
  if (id === undefined || timestamp === undefined || signature === undefined) {
    return false;
  }

  // Seconds since the epoch, as Svix sends it. Anything else is a forgery or a
  // broken sender; either way it must not be treated as "no timestamp given".
  if (!/^\d{1,15}$/.test(timestamp)) {
    return false;
  }

  const sentAtMs = Number(timestamp) * 1000;
  const driftSeconds = Math.abs(now.getTime() - sentAtMs) / 1000;
  // Absolute drift, so a timestamp in the FUTURE is refused too: without that a
  // forged far-future timestamp would stay verifiable indefinitely.
  if (driftSeconds > RESEND_TIMESTAMP_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = createHmac("sha256", secretKey(secret))
    .update(signedContent(id, timestamp, rawBody))
    .digest();

  // A space-separated list; during a key rotation more than one is sent and only
  // one of them matches.
  for (const entry of signature.split(" ")) {
    const [version, value] = entry.split(",", 2);
    if (version !== SIGNATURE_VERSION || value === undefined || value === "") {
      continue;
    }

    const provided = Buffer.from(value, "base64");
    // `timingSafeEqual` THROWS on a length mismatch, and `value` is attacker
    // controlled, so the length is checked first. Never `===`: string comparison
    // short-circuits on the first differing byte and leaks a prefix through timing.
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }

  return false;
}
