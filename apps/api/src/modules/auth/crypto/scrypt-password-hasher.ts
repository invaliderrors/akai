import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  PASSWORD_HASHER_OPTIONS,
  type PasswordHasher,
  type PasswordHasherOptions,
} from "../ports/password-hasher.port";

/**
 * scrypt (RFC 7914) password hashing on top of `node:crypto`.
 *
 * WHY NOT ARGON2ID, which spec §8 names: `@node-rs/argon2` is not a dependency
 * of this workspace, and adding one means editing the root package.json and
 * pnpm-lock.yaml while other agents are writing to the same files. Rather than
 * ship a stub, this ships a real, tested, memory-hard KDF that needs nothing
 * new installed. scrypt is not a downgrade in kind — it is the algorithm PBKDF2
 * was replaced by precisely because it resists GPU/ASIC attack through memory
 * cost, which is the same property argon2id is chosen for.
 *
 * The migration path is built in rather than promised:
 *   - the stored string is self-describing (`$scrypt$n=...`), so an argon2
 *     implementation added later can be dispatched to by prefix, and both
 *     formats can sit in `customer.passwordHash` simultaneously;
 *   - `needsRehash` reports a stale format, and AuthService re-hashes on the
 *     next successful login, so the population converges with no forced reset.
 *
 * Format: $scrypt$n=<N>,r=<r>,p=<p>$<salt base64>$<derived key base64>
 */

const ALGORITHM_ID = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/**
 * Block size. Fixed at the RFC's recommended 8 — it is the parameter that ties
 * memory use to N, and varying it per-deployment would make the memory budget
 * unpredictable for no security gain.
 */
const BLOCK_SIZE = 8;

interface ScryptParams {
  readonly n: number;
  readonly r: number;
  readonly p: number;
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

/**
 * scrypt's memory use is exactly 128 * N * r bytes, and N MUST be a power of
 * two. Choosing the largest power of two that fits the configured budget means
 * raising ARGON2_MEMORY_KIB always costs at most the budget and never silently
 * overruns it into an OOM under concurrent logins.
 */
export function deriveCostParameters(options: PasswordHasherOptions): ScryptParams {
  const budgetBytes = Math.max(1, options.memoryKib) * 1024;
  const bytesPerN = 128 * BLOCK_SIZE;

  let n = 1;
  while (n * 2 * bytesPerN <= budgetBytes && n < 2 ** 22) {
    n *= 2;
  }

  // Floor of 2^14 keeps a misconfigured-but-valid tiny budget from producing a
  // hash that is cheap to attack. The config schema already enforces the OWASP
  // minimum; this is defence in depth for tests and local overrides.
  return {
    n: Math.max(n, 2 ** 14),
    r: BLOCK_SIZE,
    p: Math.min(Math.max(1, options.timeCost), 16),
  };
}

function maxmemFor(params: ScryptParams): number {
  // Node rejects the call outright if 128*N*r exceeds maxmem. Headroom is
  // deliberate: an under-set maxmem surfaces as a thrown error on every login.
  return 128 * params.n * params.r * 2 + 1024 * 1024;
}

function derive(
  plaintext: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      // Normalise so a password typed with a composed vs decomposed accent
      // (common with Spanish input methods) verifies consistently across
      // platforms. Without this, "contraseña" can hash two different ways.
      plaintext.normalize("NFKC"),
      salt,
      KEY_BYTES,
      { N: params.n, r: params.r, p: params.p, maxmem: maxmemFor(params) },
      (error: Error | null, derivedKey: Buffer) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

/**
 * Parses the stored PHC-ish string. Returns null — never throws — for anything
 * unrecognised, so a corrupted or foreign-format row fails the login instead of
 * producing a 500 that confirms the account exists.
 */
export function parseStoredHash(stored: string): ParsedHash | null {
  const segments = stored.split("$");
  // ["", "scrypt", "n=..,r=..,p=..", salt, key]
  if (segments.length !== 5) {
    return null;
  }

  const [, algorithm, rawParams, rawSalt, rawKey] = segments;
  if (algorithm !== ALGORITHM_ID) {
    return null;
  }
  if (rawParams === undefined || rawSalt === undefined || rawKey === undefined) {
    return null;
  }

  const params: Record<string, number> = {};
  for (const pair of rawParams.split(",")) {
    const [name, value] = pair.split("=");
    if (name === undefined || value === undefined) {
      return null;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return null;
    }
    params[name] = parsed;
  }

  const n = params["n"];
  const r = params["r"];
  const p = params["p"];
  if (n === undefined || r === undefined || p === undefined) {
    return null;
  }
  // N must be a power of two or scrypt itself will reject it at verify time.
  if ((n & (n - 1)) !== 0) {
    return null;
  }

  const salt = Buffer.from(rawSalt, "base64");
  const key = Buffer.from(rawKey, "base64");
  if (salt.length === 0 || key.length !== KEY_BYTES) {
    return null;
  }

  return { params: { n, r, p }, salt, key };
}

@Injectable()
export class ScryptPasswordHasher implements PasswordHasher {
  private readonly params: ScryptParams;

  constructor(
    @Inject(PASSWORD_HASHER_OPTIONS) options: PasswordHasherOptions,
  ) {
    this.params = deriveCostParameters(options);
  }

  async hash(plaintext: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await derive(plaintext, salt, this.params);
    const { n, r, p } = this.params;

    return `$${ALGORITHM_ID}$n=${n},r=${r},p=${p}$${salt.toString("base64")}$${key.toString("base64")}`;
  }

  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    const parsed = parseStoredHash(storedHash);
    if (parsed === null) {
      return false;
    }

    let candidate: Buffer;
    try {
      // Verification uses the params the hash was CREATED with, not the current
      // ones — otherwise raising the cost factor would invalidate every
      // existing password in the database.
      candidate = await derive(plaintext, parsed.salt, parsed.params);
    } catch {
      return false;
    }

    if (candidate.length !== parsed.key.length) {
      return false;
    }

    // Constant-time: a byte-by-byte early return leaks how much of the hash
    // matched, which is enough to mount an incremental forgery attack.
    return timingSafeEqual(candidate, parsed.key);
  }

  needsRehash(storedHash: string): boolean {
    const parsed = parseStoredHash(storedHash);
    if (parsed === null) {
      // Unparseable or a foreign (e.g. future argon2) format — the caller
      // should re-hash it with the current algorithm once it has the plaintext.
      return true;
    }

    return (
      parsed.params.n < this.params.n ||
      parsed.params.r < this.params.r ||
      parsed.params.p < this.params.p
    );
  }
}
