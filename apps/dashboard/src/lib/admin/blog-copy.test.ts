import { describe, expect, it } from "vitest";

import {
  EMPTY_BLOG_COPY,
  mergeBlogTranslations,
  toBlogCopy,
  toBlogTranslationTexts,
  translateBlogCopyInputSchema,
} from "./blog-copy";

describe("blog copy ↔ translation texts", () => {
  it("sends only the non-blank fields, trimmed and keyed by field", () => {
    expect(
      toBlogTranslationTexts({ ...EMPTY_BLOG_COPY, title: "  Hola ", bodyHtml: "<p>x</p>" }),
    ).toEqual([
      { key: "title", text: "Hola" },
      { key: "bodyHtml", text: "<p>x</p>" },
    ]);
  });

  it("merges results back by key, leaving what did not come back blank", () => {
    expect(mergeBlogTranslations([{ key: "excerpt", text: "Summary" }])).toEqual({
      ...EMPTY_BLOG_COPY,
      excerpt: "Summary",
    });
  });

  it("turns a stored translation's null meta into the editor's empty string", () => {
    expect(
      toBlogCopy({
        locale: "es",
        title: "T",
        excerpt: "E",
        bodyHtml: "<p>B</p>",
        metaTitle: null,
        metaDescription: "D",
        coverAlt: "",
      }),
    ).toEqual({ title: "T", excerpt: "E", bodyHtml: "<p>B</p>", metaTitle: "", metaDescription: "D", coverAlt: "" });
    expect(toBlogCopy(undefined)).toEqual(EMPTY_BLOG_COPY);
  });

  it("refuses a same-locale request", () => {
    expect(
      translateBlogCopyInputSchema.safeParse({ from: "en", to: "en", copy: EMPTY_BLOG_COPY }).success,
    ).toBe(false);
  });
});
