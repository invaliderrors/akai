/**
 * Password hashing, behind a port.
 *
 * The port exists because the algorithm is expected to change: spec §8 calls
 * for argon2id via `@node-rs/argon2`, which is not yet a workspace dependency
 * (see the module README note and followUps). The shipped implementation is
 * scrypt from `node:crypto` — a memory-hard KDF with no native build step —
 * and it writes a SELF-DESCRIBING PHC-style string, so an argon2 hash and a
 * scrypt hash can coexist in the `customer.passwordHash` column during a
 * migration and `verify` can dispatch on the prefix.
 *
 * `needsRehash` is what makes that migration actually happen: on a successful
 * login with a legacy hash the service silently re-hashes with current
 * parameters, so the population converges without a forced password reset.
 */
export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;

  /**
   * Constant-time verification. Returns false for a malformed or unknown-format
   * stored hash rather than throwing, so a corrupted row is a failed login and
   * not a 500 that reveals the row exists.
   */
  verify(storedHash: string, plaintext: string): Promise<boolean>;

  /** True when `storedHash` was produced with weaker-than-current parameters. */
  needsRehash(storedHash: string): boolean;
}

export const PASSWORD_HASHER = Symbol("PASSWORD_HASHER");

/** Tunables, injected so tests can drop the cost to keep the suite fast. */
export interface PasswordHasherOptions {
  /** Target memory in KiB. Mapped onto scrypt's N so that 128 * N * r <= this. */
  readonly memoryKib: number;
  /** Work multiplier. Maps onto scrypt's parallelism factor `p`. */
  readonly timeCost: number;
}

export const PASSWORD_HASHER_OPTIONS = Symbol("PASSWORD_HASHER_OPTIONS");
