import { describe, expect, it } from "vitest";

import {
  mergeTranslations,
  toTranslationTexts,
  translateCopyInputSchema,
  translateCopyReasonOf,
} from "./translate-copy";

/**
 * The mapping between three form fields and a keyed, metered batch.
 *
 * Everything asserted here is a decision the form cannot see and the API cannot
 * make: which fields are worth paying to translate, what a field that was not
 * translated comes back as, and which envelope reasons this dashboard has a
 * sentence for.
 */

describe("toTranslationTexts", () => {
  it("drops a blank field rather than failing the whole batch on it", () => {
    // The contract's `text` is `.trim().min(1)`, so sending the empty
    // description would be a 400 for the request as a whole — and a half-written
    // draft with a name and no description is the ordinary case this feature
    // exists for.
    const texts = toTranslationTexts({
      name: "BPC-157",
      shortDescription: "  ",
      description: "",
    });

    expect(texts).toEqual([{ key: "name", text: "BPC-157" }]);
  });

  it("trims what it does send, matching the schema that will parse it", () => {
    const texts = toTranslationTexts({
      name: "  BPC-157  ",
      shortDescription: "Péptido",
      description: "Descripción",
    });

    expect(texts).toEqual([
      { key: "name", text: "BPC-157" },
      { key: "shortDescription", text: "Péptido" },
      { key: "description", text: "Descripción" },
    ]);
  });

  it("returns nothing at all for copy with nothing in it", () => {
    // The caller stops here: a vendor that bills per call has nothing to answer.
    expect(toTranslationTexts({ name: "", shortDescription: "", description: "" })).toEqual(
      [],
    );
  });
});

describe("mergeTranslations", () => {
  it("returns a field that was never sent as blank, not as the source text", () => {
    // Echoing the source would put Spanish prose in the English box and mark it
    // translated — the one outcome worse than an empty field.
    expect(mergeTranslations([{ key: "name", text: "BPC-157" }])).toEqual({
      name: "BPC-157",
      shortDescription: "",
      description: "",
    });
  });

  it("pairs by key rather than by position", () => {
    const merged = mergeTranslations([
      { key: "description", text: "Description" },
      { key: "name", text: "BPC-157" },
    ]);

    expect(merged.name).toBe("BPC-157");
    expect(merged.description).toBe("Description");
  });

  it("ignores a key it does not know instead of discarding the batch", () => {
    const merged = mergeTranslations([
      { key: "name", text: "BPC-157" },
      { key: "subtitle", text: "Newer API, more fields" },
    ]);

    expect(merged).toEqual({ name: "BPC-157", shortDescription: "", description: "" });
  });
});

describe("translateCopyInputSchema", () => {
  it("refuses a shape with a field nobody declared", () => {
    // A server action is a public endpoint with a generated name. `.strict()` is
    // what answers a probe with a 400 rather than with a silently ignored field.
    const parsed = translateCopyInputSchema.safeParse({
      from: "es",
      to: "en",
      copy: { name: "BPC-157", shortDescription: "", description: "", price: 1 },
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a same-locale request before it costs a round trip", () => {
    const parsed = translateCopyInputSchema.safeParse({
      from: "en",
      to: "en",
      copy: { name: "BPC-157", shortDescription: "", description: "" },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("translateCopyReasonOf", () => {
  it("narrows a reason this dashboard has a sentence for", () => {
    expect(translateCopyReasonOf("QUOTA_EXCEEDED")).toBe("QUOTA_EXCEEDED");
    // The dashboard's own, decided without asking the vendor anything.
    expect(translateCopyReasonOf("EMPTY_SOURCE")).toBe("EMPTY_SOURCE");
  });

  it("answers null for a reason a newer API invented", () => {
    // Deliberate: the envelope's `reason` is a free string precisely so the API
    // can add one without a lockstep dashboard deploy. The caller falls back to
    // the coarse code rather than printing an identifier at an operator.
    expect(translateCopyReasonOf("VENDOR_ON_FIRE")).toBeNull();
    expect(translateCopyReasonOf(null)).toBeNull();
  });
});
