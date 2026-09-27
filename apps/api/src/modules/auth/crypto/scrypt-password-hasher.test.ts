import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  ScryptPasswordHasher,
  deriveCostParameters,
  parseStoredHash,
} from "./scrypt-password-hasher";

/**
 * The floor enforced by deriveCostParameters is 2^14, so every hash here costs
 * ~16 MiB and tens of milliseconds. The suite is deliberately economical with
 * hash operations for that reason — and the cost is the point: a password hash
 * that is cheap to compute is cheap to attack.
 */
const OPTIONS = { memoryKib: 19_456, timeCost: 2 } as const;

describe("deriveCostParameters", () => {
  it("picks the largest power of two that fits the memory budget", () => {
    // 128 * N * r bytes with r=8 means N == memoryKib for a power-of-two budget.
    expect(deriveCostParameters({ memoryKib: 19_456, timeCost: 2 }).n).toBe(16_384);
    expect(deriveCostParameters({ memoryKib: 65_536, timeCost: 2 }).n).toBe(65_536);
  });

  it("never returns an N below the 2^14 floor, even for a tiny budget", () => {
    // A misconfigured-but-schema-valid budget must not silently produce a hash
    // that a commodity GPU can grind.
    expect(deriveCostParameters({ memoryKib: 1, timeCost: 1 }).n).toBe(16_384);
  });

  it("always returns a power of two, which scrypt requires", () => {
    for (const memoryKib of [19_456, 20_000, 33_000, 100_000]) {
      const { n } = deriveCostParameters({ memoryKib, timeCost: 2 });
      expect(n & (n - 1)).toBe(0);
    }
  });

  it("clamps parallelism to a sane range", () => {
    expect(deriveCostParameters({ memoryKib: 19_456, timeCost: 0 }).p).toBe(1);
    expect(deriveCostParameters({ memoryKib: 19_456, timeCost: 999 }).p).toBe(16);
  });
});

describe("ScryptPasswordHasher", () => {
  const hasher = new ScryptPasswordHasher(OPTIONS);

  it("verifies a correct password and rejects a wrong one", async () => {
    const stored = await hasher.hash("correct horse battery staple");

    expect(await hasher.verify(stored, "correct horse battery staple")).toBe(true);
    expect(await hasher.verify(stored, "correct horse battery stapl")).toBe(false);
    expect(await hasher.verify(stored, "")).toBe(false);
  });

  it("salts every hash, so identical passwords do not collide", async () => {
    const [first, second] = await Promise.all([
      hasher.hash("identical-password"),
      hasher.hash("identical-password"),
    ]);

    // Equal hashes would let an attacker with a database dump instantly see
    // which accounts share a password — and rainbow-table the lot.
    expect(first).not.toBe(second);
    expect(await hasher.verify(first, "identical-password")).toBe(true);
    expect(await hasher.verify(second, "identical-password")).toBe(true);
  });

  it("emits a self-describing PHC-style string with no plaintext in it", async () => {
    const stored = await hasher.hash("a-memorable-passphrase");

    expect(stored.startsWith("$scrypt$n=16384,r=8,p=2$")).toBe(true);
    expect(stored.split("$")).toHaveLength(5);
    expect(stored).not.toContain("a-memorable-passphrase");

    const parsed = parseStoredHash(stored);
    expect(parsed?.params).toEqual({ n: 16_384, r: 8, p: 2 });
  });

  it("normalises unicode so an accented password verifies across platforms", async () => {
    // "contraseña" composed (U+00F1) vs decomposed (n + U+0303). macOS and
    // Windows input methods disagree; without NFKC the same typed password
    // hashes two different ways and the user is locked out on one device.
    const composed = "contraseña-larga-2026";
    const decomposed = "contraseña-larga-2026";
    expect(composed).not.toBe(decomposed);

    const stored = await hasher.hash(composed);
    expect(await hasher.verify(stored, decomposed)).toBe(true);
  });

  it("returns false — never throws — for a malformed or foreign stored hash", async () => {
    // A corrupted row must fail the login, not 500. A 500 here is itself an
    // oracle: it confirms the account exists.
    for (const bad of [
      "",
      "not-a-hash",
      "$scrypt$",
      "$scrypt$n=16384,r=8,p=2$only-three-parts",
      "$scrypt$n=notanumber,r=8,p=2$c2FsdA$aGFzaA",
      // N is not a power of two: scrypt itself would throw on this.
      "$scrypt$n=12345,r=8,p=2$c2FsdA$aGFzaA",
      // A future argon2 hash, which this implementation cannot verify.
      "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
    ]) {
      await expect(hasher.verify(bad, "any-password")).resolves.toBe(false);
    }
  });

  it("verifies against the parameters the hash was created with, not current ones", async () => {
    const weak = new ScryptPasswordHasher({ memoryKib: 16_384, timeCost: 1 });
    const stored = await weak.hash("legacy-password-value");

    // Raising the cost factor must not invalidate every existing password.
    const strong = new ScryptPasswordHasher({ memoryKib: 32_768, timeCost: 4 });
    expect(await strong.verify(stored, "legacy-password-value")).toBe(true);
  });

  it("flags a weaker-than-current hash for rehash, and a current one as fine", async () => {
    const weak = new ScryptPasswordHasher({ memoryKib: 16_384, timeCost: 1 });
    const stored = await weak.hash("legacy-password-value");

    const strong = new ScryptPasswordHasher({ memoryKib: 32_768, timeCost: 4 });
    expect(strong.needsRehash(stored)).toBe(true);
    expect(weak.needsRehash(stored)).toBe(false);
  });

  it("flags an unparseable or foreign-format hash for rehash", () => {
    // This is the argon2 migration hook: once @node-rs/argon2 is the primary
    // hasher, every scrypt hash reports true here and is upgraded on next login.
    expect(hasher.needsRehash("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA")).toBe(true);
    expect(hasher.needsRehash("garbage")).toBe(true);
  });
});
