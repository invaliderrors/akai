import { describe, expect, it } from "vitest";
import { CONTENT_SANITIZED_HEADER, parseSanitizedLocales } from "./catalog-headers";

/**
 * The client-side half of `CONTENT_SANITIZED_HEADER` — the API's out-of-band
 * warning that a write's description was rewritten, not saved verbatim.
 *
 * Before this, the header reached the dashboard and was silently dropped: an
 * operator who pasted a `<div style="...">` and watched it vanish learned
 * nothing at all, not even that something had been removed.
 */
describe("parseSanitizedLocales", () => {
  it("reports nothing when the header is absent", () => {
    expect(parseSanitizedLocales(undefined)).toEqual([]);
    expect(parseSanitizedLocales({})).toEqual([]);
  });

  it("reports nothing for an empty header value", () => {
    expect(parseSanitizedLocales({ [CONTENT_SANITIZED_HEADER]: "" })).toEqual([]);
  });

  it("parses a single rewritten locale", () => {
    expect(parseSanitizedLocales({ [CONTENT_SANITIZED_HEADER]: "es" })).toEqual(["es"]);
  });

  it("parses every locale in a comma-separated list", () => {
    expect(parseSanitizedLocales({ [CONTENT_SANITIZED_HEADER]: "es,en" })).toEqual(["es", "en"]);
  });

  it("tolerates whitespace around each token", () => {
    expect(parseSanitizedLocales({ [CONTENT_SANITIZED_HEADER]: "es, en" })).toEqual(["es", "en"]);
  });

  it("drops a token that is not a real locale, rather than passing raw wire data through", () => {
    // External input off the wire, validated like any other — a header this
    // build does not recognise must not surface as an unreadable raw string.
    expect(parseSanitizedLocales({ [CONTENT_SANITIZED_HEADER]: "es,fr" })).toEqual(["es"]);
  });

  it("is unaffected by an unrelated header", () => {
    expect(parseSanitizedLocales({ "content-type": "application/json" })).toEqual([]);
  });
});
