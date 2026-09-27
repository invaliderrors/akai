import { describe, expect, it } from "vitest";
import { seal, unseal } from "./seal";

const SECRET = "test-secret-that-is-at-least-32-chars-long";
const OTHER_SECRET = "a-completely-different-secret-of-good-length";

describe("seal / unseal", () => {
  it("round-trips a payload", async () => {
    const sealed = await seal('{"hello":"world"}', SECRET);
    await expect(unseal(sealed, SECRET)).resolves.toBe('{"hello":"world"}');
  });

  it("produces an opaque value that does not contain the plaintext", async () => {
    // The whole reason for encrypting rather than signing: a browser, a proxy
    // log or a HAR file must not be able to read the tokens inside.
    const sealed = await seal("super-secret-refresh-token", SECRET);
    expect(sealed).not.toContain("super-secret-refresh-token");
  });

  it("produces a different ciphertext each time for the same input", async () => {
    // A fresh random IV per seal. A deterministic ciphertext would let an
    // observer tell that two requests carry the SAME session without ever
    // decrypting it.
    const [first, second] = await Promise.all([seal("same", SECRET), seal("same", SECRET)]);
    expect(first).not.toBe(second);
  });

  it("returns null for a value sealed with a different secret", async () => {
    const sealed = await seal("payload", SECRET);
    await expect(unseal(sealed, OTHER_SECRET)).resolves.toBeNull();
  });

  it("returns null when the ciphertext is tampered with", async () => {
    // GCM's authentication tag is what makes this a rejection rather than
    // garbage plaintext. Flip one character of the ciphertext segment.
    const sealed = await seal("payload", SECRET);
    const parts = sealed.split(".");
    const ciphertext = parts[2] ?? "";
    const flipped = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
    await expect(unseal(`${parts[0]}.${parts[1]}.${flipped}`, SECRET)).resolves.toBeNull();
  });

  it.each([
    ["empty", ""],
    ["not sealed at all", "just-a-string"],
    ["wrong segment count", "v1.onlyonepart"],
    ["unknown version", "v9.AAAAAAAAAAAAAAAA.AAAAAAAA"],
    ["invalid base64", "v1.!!!!.!!!!"],
  ])("returns null rather than throwing for a %s value", async (_label, value) => {
    // Every one of these is attacker-reachable: the cookie is client-supplied.
    // Throwing would turn a forged cookie into a 500 on every page.
    await expect(unseal(value, SECRET)).resolves.toBeNull();
  });
});
