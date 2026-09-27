import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { signSendcloudBody, verifySendcloudSignature } from "./sendcloud-signature";

const SECRET = "whsk_test_secret";
const BODY = Buffer.from(
  JSON.stringify({ action: "parcel_status_changed", timestamp: 1727200000000, parcel: { id: 42 } }),
);

describe("Sendcloud webhook signature", () => {
  it("signs as hex HMAC-SHA256 of the raw body", () => {
    const expected = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(signSendcloudBody(BODY, SECRET)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a valid signature", () => {
    expect(verifySendcloudSignature(BODY, signSendcloudBody(BODY, SECRET), SECRET)).toBe(true);
  });

  it("accepts upper-case hex and surrounding whitespace", () => {
    const signature = ` ${signSendcloudBody(BODY, SECRET).toUpperCase()} `;
    expect(verifySendcloudSignature(BODY, signature, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = signSendcloudBody(BODY, SECRET);
    const tampered = Buffer.from(BODY.toString("utf8").replace("42", "43"));
    expect(verifySendcloudSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects a signature made with another key", () => {
    expect(verifySendcloudSignature(BODY, signSendcloudBody(BODY, "other"), SECRET)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifySendcloudSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifySendcloudSignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects malformed hex without throwing (short, long, non-hex)", () => {
    const valid = signSendcloudBody(BODY, SECRET);
    expect(verifySendcloudSignature(BODY, valid.slice(0, 62), SECRET)).toBe(false);
    expect(verifySendcloudSignature(BODY, `${valid}00`, SECRET)).toBe(false);
    expect(verifySendcloudSignature(BODY, `${valid.slice(0, 62)}zz`, SECRET)).toBe(false);
  });

  it("rejects everything when the secret is empty", () => {
    expect(verifySendcloudSignature(BODY, signSendcloudBody(BODY, ""), "")).toBe(false);
  });
});
