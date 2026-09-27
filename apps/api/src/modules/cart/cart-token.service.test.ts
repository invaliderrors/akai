import { describe, expect, it } from "vitest";
import { CartTokenService } from "./cart-token.service";
import { CART_TOKEN_ENCODED_LENGTH } from "./cart.constants";

const tokens = new CartTokenService();

describe("CartTokenService", () => {
  it("mints a 256-bit base64url token", () => {
    const { token } = tokens.mint();

    expect(token).toHaveLength(CART_TOKEN_ENCODED_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never mints the same token twice", () => {
    const minted = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      minted.add(tokens.mint().token);
    }
    expect(minted.size).toBe(500);
  });

  /**
   * The token is a bearer credential for a cart. Storing it in plaintext means a
   * database leak hands over every live cart; storing the hash means it does
   * not. Same reasoning as refresh tokens in spec §8.
   */
  it("returns a hash that is not the token itself", () => {
    const { token, tokenHash } = tokens.mint();

    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toHaveLength(64);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
  });

  it("hashes deterministically so a presented token resolves to its cart", () => {
    const { token, tokenHash } = tokens.mint();
    expect(tokens.hash(token)).toBe(tokenHash);
  });

  it("produces different hashes for different tokens", () => {
    expect(tokens.hash("a".repeat(43))).not.toBe(tokens.hash("b".repeat(43)));
  });

  describe("isWellFormed", () => {
    it("accepts a freshly minted token", () => {
      expect(tokens.isWellFormed(tokens.mint().token)).toBe(true);
    });

    it.each([
      ["empty", ""],
      ["too short", "abc"],
      ["too long", "a".repeat(64)],
      ["standard base64 padding", `${"a".repeat(42)}=`],
      ["base64 plus", `${"a".repeat(42)}+`],
      ["base64 slash", `${"a".repeat(42)}/`],
      ["sql-ish", "' OR 1=1 --                                 "],
      ["whitespace", " ".repeat(43)],
      ["unicode", "é".repeat(43)],
    ])("rejects a %s token", (_label, candidate) => {
      expect(tokens.isWellFormed(candidate)).toBe(false);
    });
  });
});
