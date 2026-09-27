import { describe, expect, it } from "vitest";
import { translationFailureReasonSchema } from "./enums";
import {
  TRANSLATION_MAX_TEXTS,
  TRANSLATION_MAX_TEXT_LENGTH,
  TRANSLATION_MAX_TOTAL_CHARACTERS,
  translateRequestSchema,
  translateResponseSchema,
} from "./translation";

const VALID = {
  source: "es",
  target: "en",
  texts: [
    { key: "name", text: "Creatina monohidratada" },
    { key: "summary", text: "Pureza 99,9 %" },
    { key: "description", text: "Cada lote se analiza por HPLC." },
  ],
};

describe("translateRequestSchema", () => {
  it("accepts the product form's real payload", () => {
    expect(translateRequestSchema.safeParse(VALID).success).toBe(true);
  });

  it("admits a full-size product without complaint", () => {
    // name + summary + description at their catalogue maximums. If this ever
    // fails, the cap is stopping a legitimate save rather than an abuse.
    const result = translateRequestSchema.safeParse({
      source: "es",
      target: "en",
      texts: [
        { key: "name", text: "n".repeat(200) },
        { key: "summary", text: "s".repeat(500) },
        { key: "description", text: "d".repeat(20_000) },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown key — the request stays a whitelist", () => {
    expect(
      translateRequestSchema.safeParse({ ...VALID, formality: "prefer_less" }).success,
    ).toBe(false);
    expect(
      translateRequestSchema.safeParse({
        ...VALID,
        texts: [{ key: "name", text: "Hola", html: true }],
      }).success,
    ).toBe(false);
  });

  it("rejects a same-locale request", () => {
    // Always a caller bug, and paying a vendor round trip to hand the input
    // back would hide it behind a bill.
    expect(translateRequestSchema.safeParse({ ...VALID, target: "es" }).success).toBe(false);
  });

  it("rejects duplicate keys, which make the response impossible to pair", () => {
    const result = translateRequestSchema.safeParse({
      source: "es",
      target: "en",
      texts: [
        { key: "name", text: "uno" },
        { key: "name", text: "dos" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("caps the batch, the field and the whole request against a metered vendor", () => {
    const oneTooMany = Array.from({ length: TRANSLATION_MAX_TEXTS + 1 }, (_unused, index) => ({
      key: `field${String(index)}`,
      text: "hola",
    }));
    expect(
      translateRequestSchema.safeParse({ source: "es", target: "en", texts: oneTooMany }).success,
    ).toBe(false);

    expect(
      translateRequestSchema.safeParse({
        source: "es",
        target: "en",
        texts: [{ key: "description", text: "d".repeat(TRANSLATION_MAX_TEXT_LENGTH + 1) }],
      }).success,
    ).toBe(false);

    // Per-field caps are not a budget: two legal fields can still exceed what
    // one request may cost.
    expect(
      translateRequestSchema.safeParse({
        source: "es",
        target: "en",
        texts: [
          { key: "one", text: "a".repeat(TRANSLATION_MAX_TEXT_LENGTH) },
          { key: "two", text: "b".repeat(TRANSLATION_MAX_TEXT_LENGTH) },
        ],
      }).success,
    ).toBe(false);
    expect(TRANSLATION_MAX_TOTAL_CHARACTERS).toBeLessThan(TRANSLATION_MAX_TEXT_LENGTH * 2);
  });

  it("trims and refuses an empty field rather than paying to translate nothing", () => {
    const parsed = translateRequestSchema.parse({
      source: "es",
      target: "en",
      texts: [{ key: "name", text: "  Creatina  " }],
    });
    expect(parsed.texts[0]?.text).toBe("Creatina");

    expect(
      translateRequestSchema.safeParse({
        source: "es",
        target: "en",
        texts: [{ key: "name", text: "   " }],
      }).success,
    ).toBe(false);
  });

  it("keeps the key an identifier, not a second channel for prose", () => {
    expect(
      translateRequestSchema.safeParse({
        source: "es",
        target: "en",
        texts: [{ key: "<script>alert(1)</script>", text: "Hola" }],
      }).success,
    ).toBe(false);
  });
});

describe("translateResponseSchema", () => {
  it("allows an empty translation, which the request schema does not", () => {
    // A source string that is entirely punctuation can legitimately come back
    // empty; reusing the stricter source schema would make that our bug.
    expect(
      translateResponseSchema.safeParse({ translations: [{ key: "summary", text: "" }] }).success,
    ).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(
      translateResponseSchema.safeParse({
        translations: [{ key: "name", text: "Creatine", detected_source_language: "ES" }],
      }).success,
    ).toBe(false);
  });
});

describe("translationFailureReasonSchema", () => {
  it("pins every reason the API may emit", () => {
    // The API's TranslationError maps this union exhaustively and the dashboard
    // branches on it; a member added on one side only would ship a reason no
    // client can act on.
    expect(translationFailureReasonSchema.options).toEqual([
      "NOT_CONFIGURED",
      "INVALID_KEY",
      "QUOTA_EXCEEDED",
      "RATE_LIMITED",
      "UNSUPPORTED_LANGUAGE",
      "VENDOR_UNAVAILABLE",
      "VENDOR_TIMEOUT",
      "MALFORMED_RESPONSE",
    ]);
  });
});
