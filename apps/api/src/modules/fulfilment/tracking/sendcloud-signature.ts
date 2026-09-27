import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sendcloud webhook signature verification (spec §1 S13, §3.7).
 *
 * `Sendcloud-Signature` is the lower-case HEX HMAC-SHA256 of the raw request
 * body, keyed with the panel's Webhook Signature Key — or, when the integration
 * has none, the integration's secret key (§11a; `config.sendcloud.webhookSecret`
 * already resolves that fallback).
 *
 * Simpler than Resend's Svix scheme and weaker: there is NO timestamp inside the
 * signed content and no replay window, so a captured delivery stays verifiable
 * forever. That is survivable only because the webhook is a TRIGGER, never a
 * source of state — a replay makes us re-read Sendcloud's current state, which
 * is idempotent — and because `ProviderEvent` dedupes the delivery itself.
 */

export const SENDCLOUD_SIGNATURE_HEADER = "sendcloud-signature";

/** A SHA-256 digest is 32 bytes = 64 hex characters. */
const HEX_DIGEST = /^[0-9a-fA-F]{64}$/;

/** Signs a body exactly as Sendcloud does. Lives beside the verifier so they cannot drift. */
export function signSendcloudBody(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** True when `signature` is Sendcloud's HMAC of exactly these bytes under `secret`. */
export function verifySendcloudSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (signature === undefined || secret === "") {
    return false;
  }
  const trimmed = signature.trim();
  // Checked BEFORE decoding: `Buffer.from(x, "hex")` silently stops at the first
  // non-hex character, so "abc…zz" would decode to a shorter, different buffer
  // rather than fail.
  if (!HEX_DIGEST.test(trimmed)) {
    return false;
  }

  const provided = Buffer.from(trimmed, "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  // Never `===` on the strings: string comparison short-circuits on the first
  // differing byte and leaks a prefix through timing. Lengths are equal here
  // (the regex pins 32 bytes), which `timingSafeEqual` requires.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
