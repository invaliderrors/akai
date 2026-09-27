import { createHash, randomBytes, randomInt } from "node:crypto";

/**
 * Opaque secrets: refresh tokens, email-verification tokens, password-reset
 * tokens and TOTP recovery codes.
 *
 * All four share one rule: the database stores SHA-256 of the value and never
 * the value itself. A leaked database dump therefore yields nothing usable —
 * an attacker holding `tokenHash` cannot present a token that hashes to it.
 *
 * Plain SHA-256 (not argon2/scrypt) is correct HERE and only here: these are
 * 256-bit uniformly random values, so there is no dictionary to attack and no
 * benefit to a slow hash. Passwords are low-entropy and get the memory-hard
 * treatment instead — the distinction is the entropy of the input, not the
 * sensitivity of the secret.
 */

/** 32 bytes = 256 bits of entropy, per spec §8. */
const TOKEN_BYTES = 32;

export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashOpaqueToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Recovery-code alphabet: Crockford-style, with I/L/O/U removed.
 *
 * These get read off a screen and typed by a locked-out human, often from a
 * printout. Excluding the characters that are routinely misread as 1/0 turns a
 * class of support tickets into a non-event.
 */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const RECOVERY_CODE_LENGTH = 10;
const RECOVERY_CODE_COUNT = 10;

/**
 * Formatted as XXXXX-XXXXX. `randomInt` is the rejection-sampling CSPRNG helper,
 * not `Math.random()` and not `bytes[i] % alphabet.length` — the modulo version
 * is subtly biased toward the start of the alphabet.
 */
export function generateRecoveryCode(): string {
  let code = "";
  for (let index = 0; index < RECOVERY_CODE_LENGTH; index += 1) {
    const position = randomInt(0, RECOVERY_ALPHABET.length);
    code += RECOVERY_ALPHABET.charAt(position);
    if (index === 4) {
      code += "-";
    }
  }
  return code;
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

/**
 * Canonicalise before hashing so "abcde-fghij", "ABCDE-FGHIJ" and "abcdefghij"
 * are the same code. Without this, a user who types their code without the
 * dash is told it is invalid.
 */
export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normaliseRecoveryCode(code), "utf8").digest("hex");
}
