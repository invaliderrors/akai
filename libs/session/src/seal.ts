/**
 * Authenticated encryption for the session cookie.
 *
 * WHY Web Crypto and not `node:crypto`: this module is imported by
 * `src/middleware.ts`, which Next runs on the Edge runtime where `node:crypto`
 * does not exist. `crypto.subtle` is present in BOTH Node 20 and Edge, so one
 * implementation serves middleware, route handlers and server components. A
 * second Node-only implementation would drift from this one and the drift would
 * surface as "session works in dev, silently fails at the edge".
 *
 * WHY encrypt rather than sign: the payload contains a live access token and a
 * live refresh token. A signed-but-readable cookie would put both in plain view
 * of anything that can read a HAR file or a proxy log. AES-256-GCM gives
 * confidentiality AND integrity in one pass, so a tampered cookie fails to
 * decrypt rather than decoding into an attacker-chosen principal.
 */

const SEAL_VERSION = "v1";
const IV_BYTES = 12; // 96 bits — the GCM-recommended nonce size.

/**
 * Derived keys are cached per secret. Key import is pure CPU work, but doing it
 * on every request in middleware is a measurable cost on a hot path for no
 * benefit; the input is a process-lifetime constant.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached !== undefined) {
    return cached;
  }

  // SHA-256 stretches an arbitrary-length secret to exactly the 256 bits
  // AES-256 requires. It is NOT a password KDF and does not need to be: the
  // secret is high-entropy machine-generated material, not a human password.
  const derived = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(secret))
    .then((digest) =>
      crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]),
    );

  keyCache.set(secret, derived);
  return derived;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The `<ArrayBuffer>` type argument is not decoration. TypeScript 5.7 made
 * `Uint8Array` generic over its backing buffer, and the default
 * `ArrayBufferLike` includes `SharedArrayBuffer`, which `BufferSource` — and
 * therefore `crypto.subtle` — does not accept. Without it the decrypt call
 * fails to compile.
 */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    // Not valid base64 — an attacker-supplied or truncated cookie. Treated as
    // "no session" by the caller rather than crashing the request.
    return null;
  }
}

/**
 * Encrypts `plaintext` into an opaque, URL-safe cookie value.
 *
 * Format: `v1.<base64url iv>.<base64url ciphertext||tag>`. The version prefix
 * exists so a future algorithm change can be rolled out by accepting both
 * formats for one deploy instead of logging every user out.
 */
export async function seal(plaintext: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  return `${SEAL_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypts a cookie value produced by {@link seal}.
 *
 * Returns null — never throws — for every failure mode: wrong version, mangled
 * base64, truncated payload, wrong key, tampered ciphertext. Callers treat null
 * as "anonymous", so a forged cookie degrades to a sign-in prompt rather than a
 * 500. Distinguishing the failure modes to the caller would leak whether a
 * given cookie was merely stale or actively forged.
 */
export async function unseal(token: string, secret: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [version, encodedIv, encodedCiphertext] = parts;
  if (version !== SEAL_VERSION || encodedIv === undefined || encodedCiphertext === undefined) {
    return null;
  }

  const iv = fromBase64Url(encodedIv);
  const ciphertext = fromBase64Url(encodedCiphertext);
  if (iv === null || ciphertext === null || iv.length !== IV_BYTES) {
    return null;
  }

  try {
    const key = await importKey(secret);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    // GCM tag mismatch. This is the branch a forged or re-keyed cookie lands in.
    return null;
  }
}
