import { createDecipheriv, createCipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for secrets that must be RECOVERABLE, not just
 * verifiable — today that means the TOTP shared secret.
 *
 * A TOTP secret cannot be hashed: generating the expected code requires the
 * original bytes. `libs/db`'s schema comment states it is "encrypted at rest by
 * the application", and this is that encryption. AES-256-GCM gives
 * confidentiality AND integrity, so a tampered ciphertext fails to open rather
 * than decrypting to attacker-chosen bytes.
 *
 * KEY DERIVATION: spec §14 defines no dedicated TOTP key, so the key is derived
 * from JWT_ACCESS_SECRET via HKDF-SHA256 with a distinct `info` label. Domain
 * separation means the derived key is cryptographically independent of the JWT
 * signing key — recovering one does not yield the other. It is still a shared
 * ROOT secret, which is why a dedicated `TOTP_ENCRYPTION_KEY` is listed in
 * followUps: today, rotating the JWT secret would orphan every enrolled TOTP
 * secret, and those two things should be rotatable on different schedules.
 */

const KEY_INFO = "akai:totp-secret-encryption:v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const VERSION = "v1";

export function deriveEncryptionKey(rootSecret: string): Buffer {
  // Empty salt is acceptable for HKDF when the input keying material is already
  // high-entropy (the config schema enforces >= 32 chars of random data) and
  // the `info` label provides the domain separation.
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(rootSecret, "utf8"), Buffer.alloc(0), KEY_INFO, KEY_BYTES),
  );
}

/** Encoded as `v1.<iv>.<ciphertext>.<tag>`, all base64url. */
export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(".");
}

/**
 * Returns null rather than throwing on any failure — wrong key, tampered
 * ciphertext, malformed envelope. Callers treat "cannot open" as "no TOTP
 * configured", which fails closed without turning a corrupted row into a 500.
 */
export function open(sealed: string, key: Buffer): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const [version, rawIv, rawCiphertext, rawTag] = parts;
  if (
    version !== VERSION ||
    rawIv === undefined ||
    rawCiphertext === undefined ||
    rawTag === undefined
  ) {
    return null;
  }

  const iv = Buffer.from(rawIv, "base64url");
  const ciphertext = Buffer.from(rawCiphertext, "base64url");
  const authTag = Buffer.from(rawTag, "base64url");

  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    return null;
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    // `final()` is what verifies the GCM tag; omitting it would accept forged
    // ciphertext, so it is never optional.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
