import { describe, expect, it } from "vitest";

import { EMPTY_BLOG_COPY, toBlogCopy } from "./blog-copy";

describe("toBlogCopy", () => {
  it("turns a stored post's null meta into the editor's empty string", () => {
    expect(
      toBlogCopy({
        title: "T",
        excerpt: "E",
        bodyHtml: "<p>B</p>",
        metaTitle: null,
        metaDescription: "D",
        coverAlt: "",
      }),
    ).toEqual({ title: "T", excerpt: "E", bodyHtml: "<p>B</p>", metaTitle: "", metaDescription: "D", coverAlt: "" });
  });

  it("starts a new post blank", () => {
    expect(toBlogCopy(undefined)).toEqual(EMPTY_BLOG_COPY);
  });
});
