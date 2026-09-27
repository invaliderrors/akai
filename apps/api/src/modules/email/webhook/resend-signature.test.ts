import { describe, expect, it } from "vitest";

import {
  RESEND_TIMESTAMP_TOLERANCE_SECONDS,
  signResendBody,
  verifyResendSignature,
} from "./resend-signature";

/**
 * Resend signs with Svix, and every difference from the Whop scheme is a
 * way to get this silently wrong.
 */

const SECRET = `whsec_${Buffer.from("a-resend-signing-secret-of-decent-length").toString("base64")}`;
const NOW = new Date("2026-09-09T12:00:00.000Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const ID = "msg_2abcDEF";

const BODY = Buffer.from(
  JSON.stringify({ type: "email.delivered", data: { email_id: "re_123" } }),
  "utf8",
);

function headers(overrides: Partial<{ id: string; timestamp: string; signature: string }> = {}) {
  return {
    id: overrides.id ?? ID,
    timestamp: overrides.timestamp ?? TIMESTAMP,
    signature:
      overrides.signature ?? signResendBody(BODY, { id: ID, timestamp: TIMESTAMP }, SECRET),
  };
}

describe("verifyResendSignature", () => {
  it("accepts a signature produced by the matching signer", () => {
    expect(verifyResendSignature(BODY, headers(), SECRET, NOW)).toBe(true);
  });

  it("signs the ID AND TIMESTAMP, not the body alone", () => {
    // The whole point of the Svix scheme: a signature captured from one delivery
    // must not verify under a different id, or a replay is trivially reusable.
    const signature = signResendBody(BODY, { id: ID, timestamp: TIMESTAMP }, SECRET);
    expect(verifyResendSignature(BODY, headers({ id: "msg_other", signature }), SECRET, NOW)).toBe(
      false,
    );
    expect(
      verifyResendSignature(
        BODY,
        headers({ timestamp: String(Number(TIMESTAMP) - 1), signature }),
        SECRET,
        NOW,
      ),
    ).toBe(false);
  });

  it("rejects a body altered by even one byte", () => {
    const tampered = Buffer.from(
      JSON.stringify({ type: "email.delivered", data: { email_id: "re_999" } }),
      "utf8",
    );
    expect(verifyResendSignature(tampered, headers(), SECRET, NOW)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const other = `whsec_${Buffer.from("a-completely-different-signing-secret!!").toString("base64")}`;
    const signature = signResendBody(BODY, { id: ID, timestamp: TIMESTAMP }, other);
    expect(verifyResendSignature(BODY, headers({ signature }), SECRET, NOW)).toBe(false);
  });

  it("uses the DECODED secret as the key, so the whsec_ prefix is optional", () => {
    // Svix's own libraries accept either. An operator who pasted the value
    // without its prefix should get a working verifier, not a silent mismatch.
    const bare = SECRET.slice("whsec_".length);
    const signature = signResendBody(BODY, { id: ID, timestamp: TIMESTAMP }, bare);
    expect(verifyResendSignature(BODY, headers({ signature }), SECRET, NOW)).toBe(true);
  });

  describe("signature list (key rotation)", () => {
    it("accepts when ONE of several entries matches", () => {
      // During a rotation Resend sends two signatures and only one verifies.
      const valid = signResendBody(BODY, { id: ID, timestamp: TIMESTAMP }, SECRET);
      const stale = "v1,YmFkc2lnbmF0dXJl";
      expect(
        verifyResendSignature(BODY, headers({ signature: `${stale} ${valid}` }), SECRET, NOW),
      ).toBe(true);
    });

    it("rejects when none matches", () => {
      expect(
        verifyResendSignature(
          BODY,
          headers({ signature: "v1,YmFkc2ln v1,d29yc2U=" }),
          SECRET,
          NOW,
        ),
      ).toBe(false);
    });

    it("ignores an entry with an unknown version", () => {
      const valid = signResendBody(BODY, { id: ID, timestamp: TIMESTAMP }, SECRET);
      const wrongVersion = valid.replace("v1,", "v2,");
      expect(verifyResendSignature(BODY, headers({ signature: wrongVersion }), SECRET, NOW)).toBe(
        false,
      );
    });
  });

  describe("replay window", () => {
    it("rejects a delivery older than the tolerance", () => {
      const old = new Date(NOW.getTime() + (RESEND_TIMESTAMP_TOLERANCE_SECONDS + 60) * 1000);
      // The signature is authentic; only the age disqualifies it. Without this
      // check a captured delivery stays replayable forever.
      expect(verifyResendSignature(BODY, headers(), SECRET, old)).toBe(false);
    });

    it("rejects a timestamp in the FUTURE beyond the tolerance", () => {
      const past = new Date(NOW.getTime() - (RESEND_TIMESTAMP_TOLERANCE_SECONDS + 60) * 1000);
      expect(verifyResendSignature(BODY, headers(), SECRET, past)).toBe(false);
    });

    it("allows ordinary clock skew inside the tolerance", () => {
      const skewed = new Date(NOW.getTime() + 60 * 1000);
      expect(verifyResendSignature(BODY, headers(), SECRET, skewed)).toBe(true);
    });

    it("rejects a non-numeric timestamp rather than treating it as absent", () => {
      expect(verifyResendSignature(BODY, headers({ timestamp: "not-a-time" }), SECRET, NOW)).toBe(
        false,
      );
    });
  });

  describe("missing headers", () => {
    it.each(["id", "timestamp", "signature"] as const)("rejects a missing %s", (field) => {
      const complete = headers();
      expect(
        verifyResendSignature(BODY, { ...complete, [field]: undefined }, SECRET, NOW),
      ).toBe(false);
    });
  });

  it("does not throw on a signature of the wrong LENGTH", () => {
    // `timingSafeEqual` throws on a length mismatch, and this value is attacker
    // controlled — a throw here would be a 500 on every malformed delivery.
    expect(() =>
      verifyResendSignature(BODY, headers({ signature: "v1,YQ==" }), SECRET, NOW),
    ).not.toThrow();
    expect(verifyResendSignature(BODY, headers({ signature: "v1,YQ==" }), SECRET, NOW)).toBe(false);
  });
});
