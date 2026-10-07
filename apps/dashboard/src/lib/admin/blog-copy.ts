import type { BlogPostCopy } from "@akai/contracts";

/**
 * A blog post's copy as the editor holds it.
 *
 * Every field is a plain string here, `""` meaning "not written yet": the
 * form's inputs are strings, and the optional meta fields become `null` only
 * when the form builds its request.
 */
export const BLOG_COPY_FIELDS = [
  "title",
  "excerpt",
  "bodyHtml",
  "metaTitle",
  "metaDescription",
  "coverAlt",
] as const;

export type BlogCopyField = (typeof BLOG_COPY_FIELDS)[number];

export type BlogCopy = Readonly<Record<BlogCopyField, string>>;

export const EMPTY_BLOG_COPY: BlogCopy = {
  title: "",
  excerpt: "",
  bodyHtml: "",
  metaTitle: "",
  metaDescription: "",
  coverAlt: "",
};

/** A stored post's copy → the editor's all-strings copy. */
export function toBlogCopy(post: BlogPostCopy | undefined): BlogCopy {
  if (post === undefined) return EMPTY_BLOG_COPY;
  return {
    title: post.title,
    excerpt: post.excerpt,
    bodyHtml: post.bodyHtml,
    metaTitle: post.metaTitle ?? "",
    metaDescription: post.metaDescription ?? "",
    coverAlt: post.coverAlt,
  };
}
