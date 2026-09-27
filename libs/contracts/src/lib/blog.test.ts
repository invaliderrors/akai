import { describe, expect, it } from "vitest";

import {
  blogCoverUploadUrlRequestSchema,
  blogPostDetailQuerySchema,
  blogPostListQuerySchema,
  createBlogPostSchema,
  isBlogCoverObjectKey,
  publicBlogPostSchema,
  publicBlogPostSummarySchema,
  updateBlogPostSchema,
} from "./blog";
import { REVALIDATE_TAG_BLOG, revalidateRequestSchema } from "./support";

const POST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const ES = {
  locale: "es",
  title: "  Cómo combinar un oversize  ",
  excerpt: "Una introducción.",
  bodyHtml: "<p>Cuerpo</p>",
};

describe("createBlogPostSchema", () => {
  const valid = { slug: "como-combinar-un-oversize", category: "STYLE_GUIDES", translations: [ES] };

  it("accepts a Spanish-only post (D8c) and trims its copy", () => {
    const parsed = createBlogPostSchema.parse(valid);

    expect(parsed.translations).toHaveLength(1);
    expect(parsed.translations[0]?.title).toBe("Cómo combinar un oversize");
    expect(parsed.translations[0]?.metaTitle).toBeNull();
    expect(parsed.translations[0]?.coverAlt).toBe("");
  });

  it("requires a Spanish translation — the default-locale page is the canonical one", () => {
    const result = createBlogPostSchema.safeParse({
      ...valid,
      translations: [{ ...ES, locale: "en" }],
    });

    expect(result.success).toBe(false);
  });

  it("refuses two rows for the same locale", () => {
    const result = createBlogPostSchema.safeParse({ ...valid, translations: [ES, ES] });

    expect(result.success).toBe(false);
  });

  it("refuses a category outside the fixed list (D8b)", () => {
    expect(createBlogPostSchema.safeParse({ ...valid, category: "Lifestyle" }).success).toBe(false);
  });

  it("refuses a blank body, a bad slug and an unknown key", () => {
    expect(
      createBlogPostSchema.safeParse({ ...valid, translations: [{ ...ES, bodyHtml: "   " }] })
        .success,
    ).toBe(false);
    expect(createBlogPostSchema.safeParse({ ...valid, slug: "Not A Slug" }).success).toBe(false);
    expect(createBlogPostSchema.safeParse({ ...valid, status: "PUBLISHED" }).success).toBe(false);
  });

  it("has no cover field — the key is scoped to an id that does not exist yet", () => {
    expect(
      createBlogPostSchema.safeParse({ ...valid, coverObjectKey: "blog/x/y.png" }).success,
    ).toBe(false);
  });
});

describe("updateBlogPostSchema", () => {
  it("accepts an empty patch and an explicit cover removal", () => {
    expect(updateBlogPostSchema.parse({})).toEqual({});
    expect(updateBlogPostSchema.parse({ coverObjectKey: null })).toEqual({ coverObjectKey: null });
  });

  it("applies the same translation rules as a create when translations are sent", () => {
    expect(
      updateBlogPostSchema.safeParse({ translations: [{ ...ES, locale: "en" }] }).success,
    ).toBe(false);
  });
});

describe("list and detail queries", () => {
  it("leaves the locale unset when absent — the sitemap wants every post", () => {
    expect(blogPostListQuerySchema.parse({})).toEqual({ limit: 12 });
  });

  it("coerces the limit from a query string and caps it", () => {
    expect(blogPostListQuerySchema.parse({ limit: "4", locale: "en" })).toEqual({
      limit: 4,
      locale: "en",
    });
    expect(blogPostListQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });

  it("rejects an unknown locale and an unknown key", () => {
    expect(blogPostDetailQuerySchema.safeParse({ locale: "fr" }).success).toBe(false);
    expect(blogPostListQuerySchema.safeParse({ status: "DRAFT" }).success).toBe(false);
  });
});

describe("public shapes", () => {
  const summary = {
    id: POST_ID,
    slug: "como-combinar-un-oversize",
    category: "STYLE_GUIDES",
    publishedAt: "2026-09-24T10:00:00.000Z",
    coverUrl: null,
    translations: [{ locale: "es", title: "T", excerpt: "E", coverAlt: "" }],
  };

  it("parses a summary and refuses one carrying a body or a status", () => {
    expect(publicBlogPostSummarySchema.parse(summary)).toEqual(summary);
    expect(
      publicBlogPostSummarySchema.safeParse({ ...summary, status: "DRAFT" }).success,
    ).toBe(false);
  });

  it("never carries the private object key", () => {
    expect(
      publicBlogPostSchema.safeParse({
        ...summary,
        coverObjectKey: "blog/x/y.png",
        translations: [
          { ...summary.translations[0], bodyHtml: "<p>x</p>", metaTitle: null, metaDescription: null },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("cover upload", () => {
  it("accepts the product-media image whitelist and refuses SVG", () => {
    expect(
      blogCoverUploadUrlRequestSchema.safeParse({ contentType: "image/webp", sizeBytes: 1000 })
        .success,
    ).toBe(true);
    expect(
      blogCoverUploadUrlRequestSchema.safeParse({ contentType: "image/svg+xml", sizeBytes: 1000 })
        .success,
    ).toBe(false);
  });

  it("refuses a client-chosen object key", () => {
    expect(
      blogCoverUploadUrlRequestSchema.safeParse({
        contentType: "image/png",
        sizeBytes: 1000,
        objectKey: "../../etc/passwd",
      }).success,
    ).toBe(false);
  });

  it("recognises only this post's minted keys", () => {
    expect(isBlogCoverObjectKey(POST_ID, `blog/${POST_ID}/2026-09-24T10-00-00-000Z-ab12.webp`)).toBe(
      true,
    );
    expect(isBlogCoverObjectKey(POST_ID, `blog/other/2026.webp`)).toBe(false);
    expect(isBlogCoverObjectKey(POST_ID, `products/${POST_ID}/a.webp`)).toBe(false);
    expect(isBlogCoverObjectKey(POST_ID, `blog/${POST_ID}/../x.webp`)).toBe(false);
    expect(isBlogCoverObjectKey(POST_ID, `blog/${POST_ID}/a.svg`)).toBe(false);
  });
});

describe("REVALIDATE_TAG_BLOG", () => {
  it("is a tag the signed revalidation body accepts", () => {
    expect(revalidateRequestSchema.parse({ tags: [REVALIDATE_TAG_BLOG] })).toEqual({
      tags: ["blog"],
    });
  });
});
