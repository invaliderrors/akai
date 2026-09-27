import { z } from "zod";
import {
  localeSchema,
  type BlogPostTranslation,
  type TranslationResult,
  type TranslationSource,
} from "@akai/contracts";

/**
 * A blog post's per-locale copy as the editor holds it, and the bridge between
 * that and the DeepL `/admin/translations` endpoint.
 *
 * THE BLOG TWIN OF `translate-copy.ts`, which is keyed to a product's three
 * fields. The mechanics are identical and deliberately so — one key per field,
 * blank fields never sent (the vendor bills per character and a blank can only
 * translate to a blank), results merged back by key so a dropped field comes
 * back blank rather than carrying the source language into the other box.
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

export const blogCopySchema = z
  .object({
    title: z.string(),
    excerpt: z.string(),
    bodyHtml: z.string(),
    metaTitle: z.string(),
    metaDescription: z.string(),
    coverAlt: z.string(),
  })
  .strict();

export type BlogCopy = z.infer<typeof blogCopySchema>;

export const EMPTY_BLOG_COPY: BlogCopy = {
  title: "",
  excerpt: "",
  bodyHtml: "",
  metaTitle: "",
  metaDescription: "",
  coverAlt: "",
};

/** What `translateBlogCopyAction` accepts — re-parsed there, since an action is a public endpoint. */
export const translateBlogCopyInputSchema = z
  .object({
    from: localeSchema,
    to: localeSchema,
    copy: blogCopySchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.from === input.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "source and target must differ",
      });
    }
  });

export type TranslateBlogCopyInput = z.infer<typeof translateBlogCopyInputSchema>;

/** Non-blank fields only, keyed by field name. */
export function toBlogTranslationTexts(copy: BlogCopy): TranslationSource[] {
  return BLOG_COPY_FIELDS.flatMap((key) => {
    const text = copy[key].trim();
    return text === "" ? [] : [{ key, text }];
  });
}

/** Results back into a whole copy; a field the vendor did not return is blank. */
export function mergeBlogTranslations(results: readonly TranslationResult[]): BlogCopy {
  const byKey = new Map(results.map((result) => [result.key, result.text]));
  return {
    title: byKey.get("title") ?? "",
    excerpt: byKey.get("excerpt") ?? "",
    bodyHtml: byKey.get("bodyHtml") ?? "",
    metaTitle: byKey.get("metaTitle") ?? "",
    metaDescription: byKey.get("metaDescription") ?? "",
    coverAlt: byKey.get("coverAlt") ?? "",
  };
}

/** A stored translation → the editor's all-strings copy. */
export function toBlogCopy(translation: BlogPostTranslation | undefined): BlogCopy {
  if (translation === undefined) return EMPTY_BLOG_COPY;
  return {
    title: translation.title,
    excerpt: translation.excerpt,
    bodyHtml: translation.bodyHtml,
    metaTitle: translation.metaTitle ?? "",
    metaDescription: translation.metaDescription ?? "",
    coverAlt: translation.coverAlt,
  };
}
