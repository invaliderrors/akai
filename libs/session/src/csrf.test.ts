import { describe, expect, it } from "vitest";
import { createCsrfToken, timingSafeEqual, verifyCsrf } from "./csrf";

describe("createCsrfToken", () => {
  it("produces a URL-safe token with no base64 padding", () => {
    const token = createCsrfToken();
    // Padding and +/ would be percent-encoded in a cookie, so the value the
    // server compares would differ from the one the script read back.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a distinct token each call", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createCsrfToken()));
    expect(tokens.size).toBe(50);
  });
});

describe("timingSafeEqual", () => {
  it("matches identical strings", () => {
    expect(timingSafeEqual("abcdef", "abcdef")).toBe(true);
  });

  it("rejects strings differing in the last character", () => {
    expect(timingSafeEqual("abcdef", "abcdeg")).toBe(false);
  });

  it("rejects strings differing in the first character", () => {
    expect(timingSafeEqual("abcdef", "zbcdef")).toBe(false);
  });

  it("rejects strings of different lengths", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("treats the empty string as equal only to itself", () => {
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("", "a")).toBe(false);
  });
});

describe("verifyCsrf", () => {
  it("accepts a matching pair", () => {
    const token = createCsrfToken();
    expect(verifyCsrf(token, token)).toBe(true);
  });

  it("rejects a mismatched pair", () => {
    expect(verifyCsrf(createCsrfToken(), createCsrfToken())).toBe(false);
  });

  it.each([
    ["a missing cookie", undefined, "header-token"],
    ["a missing header", "cookie-token", null],
    ["both missing", undefined, null],
    ["an empty cookie", "", "header-token"],
    ["an empty header", "cookie-token", ""],
  ])("fails closed on %s", (_label, cookie, header) => {
    // The dangerous alternative is skipping the check when a half is absent
    // "for old clients" — which disables the control for exactly the attacker
    // who chooses not to send it.
    expect(verifyCsrf(cookie, header)).toBe(false);
  });

  it("rejects a cookie value that is a prefix of the header", () => {
    expect(verifyCsrf("abc", "abcdef")).toBe(false);
  });
});
