import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { Clock } from "../ports/clock.port";
import {
  DEFAULT_TOTP_OPTIONS,
  TotpService,
  base32Decode,
  base32Encode,
  type TotpOptions,
} from "./totp.service";

/**
 * This suite is the justification for implementing TOTP in-repo rather than
 * pulling in `otplib`.
 *
 * RFC 6238 Appendix B publishes reference vectors, so the implementation is
 * checked against THE STANDARD rather than against my own understanding of it.
 * A test that only asserts "generate then verify round-trips" would pass just
 * as happily on an implementation that is internally consistent and completely
 * incompatible with Google Authenticator.
 */

/** The RFC's SHA-1 seed: the ASCII string "12345678901234567890". */
const RFC_SECRET_ASCII = "12345678901234567890";

function serviceFor(options: Partial<TotpOptions>, at: Date): TotpService {
  const clock: Clock = { now: () => at };
  return new TotpService({ ...DEFAULT_TOTP_OPTIONS, ...options }, clock);
}

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const input = Buffer.from(RFC_SECRET_ASCII, "ascii");
    const decoded = base32Decode(base32Encode(input));
    expect(decoded).not.toBeNull();
    expect(decoded?.toString("ascii")).toBe(RFC_SECRET_ASCII);
  });

  it("matches the known base32 encoding of the RFC seed", () => {
    expect(base32Encode(Buffer.from(RFC_SECRET_ASCII, "ascii"))).toBe(
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    );
  });

  it("rejects characters outside the alphabet instead of decoding partially", () => {
    // '1', '8', '0' and '9' are NOT in the RFC 4648 base32 alphabet. A lenient
    // decoder would silently skip them and produce a different secret, which
    // presents as "codes never match" with no error anywhere.
    expect(base32Decode("ABC1")).toBeNull();
    expect(base32Decode("ABC!")).toBeNull();
    expect(base32Decode("")).toBeNull();
  });

  it("tolerates lowercase, padding and whitespace from a copy-pasted secret", () => {
    const canonical = base32Encode(Buffer.from(RFC_SECRET_ASCII, "ascii"));
    const messy = `${canonical.toLowerCase()}===`;
    expect(base32Decode(messy)?.toString("ascii")).toBe(RFC_SECRET_ASCII);
  });
});

describe("TotpService — RFC 6238 Appendix B reference vectors", () => {
  const secret = base32Encode(Buffer.from(RFC_SECRET_ASCII, "ascii"));

  // [unix seconds, expected 8-digit SHA-1 TOTP]
  const vectors: readonly (readonly [number, string])[] = [
    [59, "94287082"],
    [1_111_111_109, "07081804"],
    [1_111_111_111, "14050471"],
    [1_234_567_890, "89005924"],
    [2_000_000_000, "69279037"],
    [20_000_000_000, "65353130"],
  ];

  for (const [unixSeconds, expected] of vectors) {
    it(`produces ${expected} at T=${unixSeconds}`, () => {
      const at = new Date(unixSeconds * 1000);
      const service = serviceFor({ digits: 8 }, at);
      expect(service.generate(secret, at)).toBe(expected);
    });
  }

  it("verifies its own reference output", () => {
    const at = new Date(59 * 1000);
    const service = serviceFor({ digits: 8, window: 0 }, at);
    expect(service.verify(secret, "94287082", at).valid).toBe(true);
  });
});

describe("TotpService — verification boundaries", () => {
  const at = new Date("2026-07-20T12:00:00.000Z");
  const secret = base32Encode(Buffer.from(RFC_SECRET_ASCII, "ascii"));

  it("accepts a code from the previous and next step within the window", () => {
    const service = serviceFor({ window: 1 }, at);

    const previous = service.generate(secret, new Date(at.getTime() - 30_000));
    const next = service.generate(secret, new Date(at.getTime() + 30_000));

    expect(previous).not.toBeNull();
    expect(next).not.toBeNull();
    expect(service.verify(secret, previous ?? "", at).valid).toBe(true);
    expect(service.verify(secret, next ?? "", at).valid).toBe(true);
  });

  it("rejects a code two steps old — the window is a boundary, not a suggestion", () => {
    const service = serviceFor({ window: 1 }, at);
    const stale = service.generate(secret, new Date(at.getTime() - 90_000));
    expect(service.verify(secret, stale ?? "", at).valid).toBe(false);
  });

  it("rejects a wrong code, a wrong length and non-numeric input", () => {
    const service = serviceFor({}, at);
    expect(service.verify(secret, "000000", at).valid).toBe(false);
    expect(service.verify(secret, "12345", at).valid).toBe(false);
    expect(service.verify(secret, "abcdef", at).valid).toBe(false);
  });

  it("rejects everything when the stored secret is not valid base32", () => {
    const service = serviceFor({}, at);
    // Fails CLOSED. A decoder that threw here would turn a corrupted row into a
    // 500; one that defaulted to an empty key would accept attacker-computable
    // codes.
    expect(service.verify("not-base32!", "123456", at).valid).toBe(false);
    expect(service.generate("not-base32!", at)).toBeNull();
  });

  it("reports the matched counter so replay can be prevented by the caller", () => {
    const service = serviceFor({ window: 1 }, at);
    const code = service.generate(secret, at);
    const result = service.verify(secret, code ?? "", at);

    expect(result.valid).toBe(true);
    expect(result.counter).toBe(Math.floor(at.getTime() / 1000 / 30));
  });

  it("pads short codes so a leading-zero code is not silently truncated", () => {
    // Roughly one code in ten begins with a zero. An implementation that
    // formats without padding rejects all of them.
    const service = serviceFor({ digits: 8 }, at);
    const code = service.generate(secret, new Date(1_111_111_109 * 1000));
    expect(code).toBe("07081804");
    expect(code).toHaveLength(8);
  });
});

describe("TotpService — enrolment", () => {
  const at = new Date("2026-07-20T12:00:00.000Z");

  it("generates a decodable secret that verifies its own codes", () => {
    const service = serviceFor({}, at);
    const secret = service.generateSecret();

    expect(base32Decode(secret)).not.toBeNull();
    // 20 bytes -> 32 base32 characters.
    expect(secret).toHaveLength(32);

    const code = service.generate(secret, at);
    expect(service.verify(secret, code ?? "", at).valid).toBe(true);
  });

  it("builds an otpauth URI carrying issuer, digits and period", () => {
    const service = serviceFor({}, at);
    const uri = service.keyUri("GEZDGNBVGY3TQOJQ", "cliente@akai.shop");

    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("secret=GEZDGNBVGY3TQOJQ");
    expect(uri).toContain("issuer=Akai");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    // The label must be percent-encoded: an unescaped ':' or '@' produces a URI
    // that some authenticator apps parse into the wrong account name.
    expect(uri).toContain("Akai%3Acliente%40akai.shop");
  });
});
