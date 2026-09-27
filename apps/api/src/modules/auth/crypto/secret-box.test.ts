import { describe, expect, it } from "vitest";
import { deriveEncryptionKey, open, seal } from "./secret-box";

const ROOT = "a-root-secret-of-at-least-32-characters!!";
const KEY = deriveEncryptionKey(ROOT);

describe("secret-box", () => {
  it("round-trips a TOTP secret", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(open(seal(secret, KEY), KEY)).toBe(secret);
  });

  it("produces a different ciphertext each time, and never leaks the plaintext", () => {
    const secret = "GEZDGNBVGY3TQOJQ";
    const first = seal(secret, KEY);
    const second = seal(secret, KEY);

    // A fresh IV per seal. Reusing an IV under AES-GCM is catastrophic: it
    // leaks the XOR of the two plaintexts and can expose the auth key.
    expect(first).not.toBe(second);
    expect(first).not.toContain(secret);
    expect(open(first, KEY)).toBe(secret);
    expect(open(second, KEY)).toBe(secret);
  });

  it("refuses to open with the wrong key", () => {
    const other = deriveEncryptionKey("a-completely-different-root-secret-value!");
    expect(open(seal("GEZDGNBVGY3TQOJQ", KEY), other)).toBeNull();
  });

  it("refuses to open tampered ciphertext — GCM integrity, not just secrecy", () => {
    const sealed = seal("GEZDGNBVGY3TQOJQ", KEY);
    const parts = sealed.split(".");

    // Mutate a real BYTE rather than a base64 character. 16 ciphertext bytes
    // encode to 22 base64url characters, and the final character carries only
    // the low bits — editing it can decode to identical bytes, which made an
    // earlier version of this test pass or fail depending on the random IV.
    const bytes = Buffer.from(parts[2] ?? "", "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;

    const tampered = [parts[0], parts[1], bytes.toString("base64url"), parts[3]].join(".");
    expect(open(tampered, KEY)).toBeNull();
  });

  it("refuses to open when a byte of the IV is altered", () => {
    const sealed = seal("GEZDGNBVGY3TQOJQ", KEY);
    const parts = sealed.split(".");

    const iv = Buffer.from(parts[1] ?? "", "base64url");
    iv[0] = (iv[0] ?? 0) ^ 0xff;

    const tampered = [parts[0], iv.toString("base64url"), parts[2], parts[3]].join(".");
    expect(open(tampered, KEY)).toBeNull();
  });

  it("refuses to open when the auth tag is stripped or replaced", () => {
    const sealed = seal("GEZDGNBVGY3TQOJQ", KEY);
    const parts = sealed.split(".");

    expect(open([parts[0], parts[1], parts[2]].join("."), KEY)).toBeNull();
    expect(open([parts[0], parts[1], parts[2], "AAAAAAAAAAAAAAAAAAAAAA"].join("."), KEY)).toBeNull();
  });

  it("returns null rather than throwing for any malformed envelope", () => {
    for (const bad of ["", "v1", "v1.a.b", "v2.a.b.c", "....", "not-even-close"]) {
      expect(() => open(bad, KEY)).not.toThrow();
      expect(open(bad, KEY)).toBeNull();
    }
  });

  it("derives a 32-byte key deterministically from the root secret", () => {
    expect(KEY).toHaveLength(32);
    expect(deriveEncryptionKey(ROOT).equals(KEY)).toBe(true);
  });

  it("derives a key that is independent of the raw root secret", () => {
    // HKDF domain separation: holding the JWT signing key does not hand an
    // attacker the TOTP encryption key, even though they share a root.
    expect(KEY.toString("utf8")).not.toContain(ROOT);
    expect(KEY.toString("hex")).not.toBe(Buffer.from(ROOT, "utf8").toString("hex"));
  });
});
