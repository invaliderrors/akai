import { createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  CART_TOKEN_BYTES,
  CART_TOKEN_ENCODED_LENGTH,
} from "./cart.constants";

/**
 * Mints and hashes the opaque anonymous-cart token.
 *
 * The token is a BEARER CREDENTIAL: whoever holds it can read and mutate the
 * cart it names. It is therefore treated like a password, not like an id:
 *
 *  * 256 bits from `randomBytes`, never `Math.random` and never a uuid — a uuidv4
 *    carries ~122 bits and, more importantly, reads like a public identifier, so
 *    it ends up logged and pasted into support tickets.
 *  * Stored SHA-256 HASHED (`cart.tokenHash`, unique). A database leak then
 *    yields no usable cart tokens. This mirrors the refresh-token handling in
 *    spec §8.
 *  * No stretching (argon2) is used here, unlike passwords. That is deliberate,
 *    not an oversight: the input is 256 bits of uniform randomness, so there is
 *    no dictionary to attack and a slow hash would only add latency to every
 *    single cart read.
 */
@Injectable()
export class CartTokenService {
  /**
   * Returns the raw token — the only time it exists in this process — together
   * with the hash to persist. The caller hands the raw value straight to the
   * client and keeps nothing.
   */
  mint(): { token: string; tokenHash: string } {
    const token = randomBytes(CART_TOKEN_BYTES).toString("base64url");
    return { token, tokenHash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  /**
   * Shape check before the token reaches a database lookup.
   *
   * Rejecting malformed input here means a caller cannot use the cart endpoint
   * as an oracle by probing it with arbitrary strings, and it keeps junk out of
   * the indexed hash lookup. A failed shape check is reported to the caller as
   * "no cart", identically to a well-formed token that matches nothing — the
   * two cases must be indistinguishable.
   */
  isWellFormed(token: string): boolean {
    return (
      token.length === CART_TOKEN_ENCODED_LENGTH && /^[A-Za-z0-9_-]+$/.test(token)
    );
  }
}
