import { describe, expect, it } from "vitest";
import { CONTENT_SANITIZED_HEADER, parseDescriptionSanitized } from "./catalog-headers";

/**
 * The client-side half of `CONTENT_SANITIZED_HEADER` — the API's out-of-band
 * warning that a write's description was rewritten, not saved verbatim.
 *
 * Before this, the header reached the dashboard and was silently dropped: an
 * operator who pasted a `<div style="...">` and watched it vanish learned
 * nothing at all, not even that something had been removed.
 */
describe("parseDescriptionSanitized", () => {
  it("reports nothing when the header is absent", () => {
    expect(parseDescriptionSanitized(undefined)).toBe(false);
    expect(parseDescriptionSanitized({})).toBe(false);
  });

  it("reports nothing for an empty header value", () => {
    expect(parseDescriptionSanitized({ [CONTENT_SANITIZED_HEADER]: "" })).toBe(false);
  });

  it("reports a rewritten description", () => {
    expect(parseDescriptionSanitized({ [CONTENT_SANITIZED_HEADER]: "description" })).toBe(true);
  });

  it("finds the description in a comma-separated list, tolerating whitespace", () => {
    expect(
      parseDescriptionSanitized({ [CONTENT_SANITIZED_HEADER]: "summary, description" }),
    ).toBe(true);
  });

  it("ignores a token it does not recognise, rather than passing raw wire data through", () => {
    expect(parseDescriptionSanitized({ [CONTENT_SANITIZED_HEADER]: "summary" })).toBe(false);
  });

  it("is unaffected by an unrelated header", () => {
    expect(parseDescriptionSanitized({ "content-type": "application/json" })).toBe(false);
  });
});
