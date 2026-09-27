import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../ports/clock.port";

/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226), implemented on `node:crypto`.
 *
 * `otplib` is not a workspace dependency and adding one would mean writing to
 * the shared lockfile while other agents are active. TOTP is a small, fully
 * specified algorithm with OFFICIAL TEST VECTORS, which is what makes writing
 * it here defensible rather than reckless: totp.service.test.ts asserts every
 * vector from RFC 6238 Appendix B, so this is verified against the standard
 * itself and not merely against my own expectations.
 *
 * SHA-1 is the algorithm here, and that is correct rather than legacy sloppiness
 * — it is what RFC 6238 specifies and what every authenticator app (Google
 * Authenticator, 1Password, Aegis) implements. HOTP's security rests on HMAC,
 * for which SHA-1 remains sound; the collision attacks that retired SHA-1 for
 * signatures do not apply to HMAC.
 */

export interface TotpOptions {
  /** Seconds per step. 30 is the universal default; changing it breaks apps. */
  readonly stepSeconds: number;
  readonly digits: number;
  /**
   * How many steps either side of "now" are accepted. 1 means the code is
   * valid for roughly 90 seconds total, which absorbs clock drift and a user
   * typing slowly. Raising it widens the window for an intercepted code.
   */
  readonly window: number;
  /** Label shown in the authenticator app. */
  readonly issuer: string;
}

export const TOTP_OPTIONS = Symbol("TOTP_OPTIONS");

export const DEFAULT_TOTP_OPTIONS: TotpOptions = {
  stepSeconds: 30,
  digits: 6,
  window: 1,
  issuer: "Akai",
};

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding. What every authenticator app expects. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  }

  return output;
}

/** Returns null on any character outside the alphabet — never a partial decode. */
export function base32Decode(input: string): Buffer | null {
  const normalised = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  if (normalised.length === 0) {
    return null;
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of normalised) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      return null;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * HOTP, RFC 4226 §5.3.
 *
 * `digits` is applied via modulo of the dynamically-truncated 31-bit value, and
 * the result is zero-padded — a code of "004512" must not be rendered "4512",
 * which is a classic off-by-one-length bug that makes ~10% of codes fail.
 */
export function hotp(secret: Buffer, counter: number, digits: number): string {
  const counterBuffer = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer. Written as two 32-bit halves
  // because a JS number cannot hold 64 bits exactly; BigInt64 would work too
  // but this keeps the value in the safe-integer range explicitly.
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac("sha1", secret).update(counterBuffer).digest();

  // Dynamic truncation: the low 4 bits of the last byte pick the offset.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export interface TotpVerification {
  readonly valid: boolean;
  /**
   * The step the code matched. Persisting this per customer and rejecting any
   * counter <= the last accepted one is what prevents a code being replayed
   * inside its own validity window (see followUps — the column does not exist
   * yet, so this value is returned but not yet stored).
   */
  readonly counter: number | null;
}

@Injectable()
export class TotpService {
  constructor(
    @Inject(TOTP_OPTIONS) private readonly options: TotpOptions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 20 random bytes — the RFC 4226 recommended secret length for SHA-1. */
  generateSecret(): string {
    return base32Encode(randomBytes(20));
  }

  /** The `otpauth://` URI an authenticator app scans as a QR code. */
  keyUri(secret: string, accountEmail: string): string {
    const label = encodeURIComponent(`${this.options.issuer}:${accountEmail}`);
    const params = new URLSearchParams({
      secret,
      issuer: this.options.issuer,
      algorithm: "SHA1",
      digits: String(this.options.digits),
      period: String(this.options.stepSeconds),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
  }

  counterAt(date: Date): number {
    return Math.floor(date.getTime() / 1000 / this.options.stepSeconds);
  }

  generate(secret: string, at: Date = this.clock.now()): string | null {
    const key = base32Decode(secret);
    if (key === null) {
      return null;
    }
    return hotp(key, this.counterAt(at), this.options.digits);
  }

  /**
   * Verifies a submitted code across the configured window.
   *
   * Comparison is constant-time. A naive `===` on the code strings leaks, via
   * timing, how many leading digits were correct — which reduces a 6-digit
   * brute force from 10^6 to roughly 60 guesses.
   */
  verify(secret: string, submitted: string, at: Date = this.clock.now()): TotpVerification {
    const key = base32Decode(secret);
    if (key === null) {
      return { valid: false, counter: null };
    }

    const candidate = submitted.replace(/\s/g, "");
    if (!new RegExp(`^\\d{${this.options.digits}}$`).test(candidate)) {
      return { valid: false, counter: null };
    }

    const current = this.counterAt(at);
    const submittedBuffer = Buffer.from(candidate, "utf8");
    let matchedCounter: number | null = null;

    // Every step in the window is checked even after a match, so verification
    // takes the same time whether the code was right, wrong, or right at the
    // edge of the window.
    for (let offset = -this.options.window; offset <= this.options.window; offset += 1) {
      const counter = current + offset;
      if (counter < 0) {
        continue;
      }
      const expected = Buffer.from(hotp(key, counter, this.options.digits), "utf8");
      if (
        expected.length === submittedBuffer.length &&
        timingSafeEqual(expected, submittedBuffer)
      ) {
        matchedCounter = counter;
      }
    }

    return matchedCounter === null
      ? { valid: false, counter: null }
      : { valid: true, counter: matchedCounter };
  }
}
