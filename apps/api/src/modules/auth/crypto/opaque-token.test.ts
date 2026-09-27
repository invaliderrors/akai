import { describe, expect, it } from "vitest";
import {
  generateOpaqueToken,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashOpaqueToken,
  hashRecoveryCode,
  normaliseRecoveryCode,
} from "./opaque-token";

describe("opaque tokens", () => {
  it("generates 256 bits of entropy, url-safe", () => {
    const token = generateOpaqueToken();
    // 32 bytes base64url == 43 characters, unpadded.
    expect(token).toHaveLength(43);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
  });

  it("never repeats across a large sample", () => {
    const tokens = new Set(Array.from({ length: 2_000 }, () => generateOpaqueToken()));
    expect(tokens.size).toBe(2_000);
  });

  it("hashes deterministically and irreversibly", () => {
    const token = generateOpaqueToken();
    const hash = hashOpaqueToken(token);

    expect(hash).toHaveLength(64);
    expect(hashOpaqueToken(token)).toBe(hash);
    // The whole point of storing only the hash: a database dump yields nothing
    // an attacker can present back to the API.
    expect(hash).not.toContain(token);
    expect(hashOpaqueToken(generateOpaqueToken())).not.toBe(hash);
  });
});

describe("recovery codes", () => {
  it("formats as XXXXX-XXXXX from an unambiguous alphabet", () => {
    for (let index = 0; index < 200; index += 1) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{5}$/);
      // I, L, O, U and 0/1 are excluded: these get read off a printout by a
      // locked-out human and misread constantly.
      expect(code).not.toMatch(/[ILOU01]/);
    }
  });

  it("generates the requested number of distinct codes", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it("canonicalises case and dashes so a hand-typed code still matches", () => {
    expect(normaliseRecoveryCode("abcde-fghij")).toBe("ABCDEFGHIJ");
    expect(normaliseRecoveryCode("ABCDEFGHIJ")).toBe("ABCDEFGHIJ");
    expect(normaliseRecoveryCode(" abcde fghij ")).toBe("ABCDEFGHIJ");

    // All three forms must hash identically, or a user who omits the dash is
    // told their valid code is invalid.
    const canonical = hashRecoveryCode("ABCDE-FGHIJ");
    expect(hashRecoveryCode("abcde-fghij")).toBe(canonical);
    expect(hashRecoveryCode("abcdefghij")).toBe(canonical);
  });

  it("hashes to something that does not contain the code", () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(normaliseRecoveryCode(code));
  });
});
