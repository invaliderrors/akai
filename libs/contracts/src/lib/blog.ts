import { z } from "zod";
import { idSchema, isoDateTimeSchema, localeSchema, paginatedSchema, slugSchema } from "./common";

/**
 * The blog — spec 2026-09-24 §8 ("Nuestras últimas publicaciones").
 *
 * Three decisions shape every schema below:
 *
 *  - D8a: a COVER IMAGE ONLY. Post bodies go through the same `@akai/rich-text`
 *    allow-list as product descriptions, which has no `img`; inline images are
 *    a later change to that allow-list, not to these schemas.
 *  - D8b: the category is a FIXED enum, editable only by code, so the chip on a
 *    card is a translated label rather than whatever an operator typed.
 *  - D8c: a post may exist in Spanish only. `translations[]` carries only the
 *    locales that exist; the public list filters by `locale`, and the storefront
 *    404s a post page in a locale the post has no row for. There is NO fallback
 *    to another language on the public surface — an English page rendering
 *    Spanish copy is exactly what D8c rules out.
 */

/** D8b. Mirrors the `BlogCategory` Prisma enum member-for-member. */
export const blogCategorySchema = z.enum(["PEPTIDES", "RESEARCH_GUIDES", "NEWS"]);
export type BlogCategory = z.infer<typeof blogCategorySchema>;

/** Mirrors the `BlogPostStatus` Prisma enum. */
export const blogPostStatusSchema = z.enum(["DRAFT", "PUBLISHED"]);
export type BlogPostStatus = z.infer<typeof blogPostStatusSchema>;

/** Column ceilings, shared by the request schemas and the database columns. */
export const BLOG_TITLE_MAX = 200;
export const BLOG_EXCERPT_MAX = 500;
export const BLOG_BODY_MAX = 100_000;
export const BLOG_META_TITLE_MAX = 200;
export const BLOG_META_DESCRIPTION_MAX = 320;
export const BLOG_COVER_ALT_MAX = 300;

/** A post's copy in one locale, as the platform stores and serves it. */
export const blogPostTranslationSchema = z
  .object({
    locale: localeSchema,
    title: z.string().min(1).max(BLOG_TITLE_MAX),
    excerpt: z.string().max(BLOG_EXCERPT_MAX),
    bodyHtml: z.string().max(BLOG_BODY_MAX),
    metaTitle: z.string().max(BLOG_META_TITLE_MAX).nullable(),
    metaDescription: z.string().max(BLOG_META_DESCRIPTION_MAX).nullable(),
    coverAlt: z.string().max(BLOG_COVER_ALT_MAX),
  })
  .strict();

export type BlogPostTranslation = z.infer<typeof blogPostTranslationSchema>;

/** The card-sized slice of a translation — no body, no meta. */
export const blogPostSummaryTranslationSchema = blogPostTranslationSchema
  .pick({ locale: true, title: true, excerpt: true, coverAlt: true })
  .strict();

export type BlogPostSummaryTranslation = z.infer<typeof blogPostSummaryTranslationSchema>;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * One post on a list — the home section and `/blog`.
 *
 * `coverUrl` is resolved by the API from the stored object key, the same way a
 * product image's URL is; the key itself never leaves the server on this shape.
 * `publishedAt` is never null here: only published posts are served publicly.
 */
export const publicBlogPostSummarySchema = z
  .object({
    id: idSchema,
    slug: slugSchema,
    category: blogCategorySchema,
    publishedAt: isoDateTimeSchema,
    coverUrl: z.string().url().nullable(),
    translations: z.array(blogPostSummaryTranslationSchema).min(1),
  })
  .strict();

export type PublicBlogPostSummary = z.infer<typeof publicBlogPostSummarySchema>;

/** One post in full — `/blog/[slug]`. */
export const publicBlogPostSchema = publicBlogPostSummarySchema
  .extend({
    translations: z.array(blogPostTranslationSchema).min(1),
  })
  .strict();

export type PublicBlogPost = z.infer<typeof publicBlogPostSchema>;

/**
 * `GET /v1/blog/posts`.
 *
 * `locale` FILTERS (D8c): with it, only posts that have a translation in that
 * locale come back. Without it, every published post does — which is what the
 * sitemap wants, since it reads each post's available locales off the payload.
 */
export const blogPostListQuerySchema = z
  .object({
    locale: localeSchema.optional(),
    cursor: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();

export type BlogPostListQuery = z.infer<typeof blogPostListQuerySchema>;

export const publicBlogPostListResponseSchema = paginatedSchema(publicBlogPostSummarySchema);

export type PublicBlogPostListResponse = z.infer<typeof publicBlogPostListResponseSchema>;

/**
 * `GET /v1/blog/posts/:slug`. With `locale`, a post with no translation in that
 * locale is a 404 — the same answer as a post that does not exist (D8c).
 */
export const blogPostDetailQuerySchema = z
  .object({
    locale: localeSchema.optional(),
  })
  .strict();

export type BlogPostDetailQuery = z.infer<typeof blogPostDetailQuerySchema>;

// ---------------------------------------------------------------------------
// Admin surface
// ---------------------------------------------------------------------------

/** A post as an operator sees it: drafts included, the object key included. */
export const adminBlogPostSchema = z
  .object({
    id: idSchema,
    slug: slugSchema,
    status: blogPostStatusSchema,
    category: blogCategorySchema,
    publishedAt: isoDateTimeSchema.nullable(),
    coverObjectKey: z.string().min(1).max(512).nullable(),
    coverUrl: z.string().url().nullable(),
    authorId: idSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    translations: z.array(blogPostTranslationSchema),
  })
  .strict();

export type AdminBlogPost = z.infer<typeof adminBlogPostSchema>;

export const adminBlogPostListQuerySchema = z
  .object({
    status: blogPostStatusSchema.optional(),
    cursor: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type AdminBlogPostListQuery = z.infer<typeof adminBlogPostListQuerySchema>;

export const adminBlogPostListResponseSchema = paginatedSchema(adminBlogPostSchema);

export type AdminBlogPostListResponse = z.infer<typeof adminBlogPostListResponseSchema>;

/**
 * One locale's copy on a write.
 *
 * Trimmed, and `title`/`excerpt`/`bodyHtml` are required non-blank: a card
 * with an empty excerpt or a page with an empty body is a half-written post,
 * and a half-written locale is exactly what D8c lets an operator simply leave
 * out instead. The meta fields are optional — the page falls back to the title
 * and the excerpt.
 */
export const blogPostTranslationInputSchema = z
  .object({
    locale: localeSchema,
    title: z.string().trim().min(1).max(BLOG_TITLE_MAX),
    excerpt: z.string().trim().min(1).max(BLOG_EXCERPT_MAX),
    bodyHtml: z.string().trim().min(1).max(BLOG_BODY_MAX),
    metaTitle: z.string().trim().max(BLOG_META_TITLE_MAX).nullable().default(null),
    metaDescription: z.string().trim().max(BLOG_META_DESCRIPTION_MAX).nullable().default(null),
    coverAlt: z.string().trim().max(BLOG_COVER_ALT_MAX).default(""),
  })
  .strict();

export type BlogPostTranslationInput = z.infer<typeof blogPostTranslationInputSchema>;

/**
 * At most one row per locale, and Spanish always present.
 *
 * Spanish is REQUIRED because it is the store's default locale: the unprefixed
 * `/blog/<slug>` URL is the Spanish page, so a post with no Spanish row would
 * have no canonical page at all. English stays optional (D8c).
 */
const translationsInputSchema = z
  .array(blogPostTranslationInputSchema)
  .min(1)
  .max(localeSchema.options.length)
  .superRefine((translations, ctx) => {
    const seen = new Set<string>();
    for (const [index, translation] of translations.entries()) {
      if (seen.has(translation.locale)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "locale"],
          message: `Duplicate translation for locale ${translation.locale}`,
        });
      }
      seen.add(translation.locale);
    }
    if (!seen.has("es")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "A Spanish (es) translation is required",
      });
    }
  });

/**
 * Create a DRAFT. No cover and no status here: a cover key is scoped to the
 * post's id (`blog/{postId}/…`), which does not exist until this call returns,
 * and publishing is its own verb.
 */
export const createBlogPostSchema = z
  .object({
    slug: slugSchema,
    category: blogCategorySchema,
    translations: translationsInputSchema,
  })
  .strict();

export type CreateBlogPost = z.infer<typeof createBlogPostSchema>;

/**
 * A partial update. `translations`, when present, REPLACES the whole set — a
 * locale left out is removed, which is how an operator withdraws an English
 * version (D8c). `coverObjectKey: null` removes the cover.
 */
export const updateBlogPostSchema = z
  .object({
    slug: slugSchema.optional(),
    category: blogCategorySchema.optional(),
    coverObjectKey: z.string().min(1).max(512).nullable().optional(),
    translations: translationsInputSchema.optional(),
  })
  .strict();

export type UpdateBlogPost = z.infer<typeof updateBlogPostSchema>;

/**
 * The image types an operator may upload — the same whitelist product media
 * uses. SVG is absent on purpose: it executes script on the origin serving it.
 */
export const imageUploadContentTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);

export type ImageUploadContentType = z.infer<typeof imageUploadContentTypeSchema>;

/** 15 MiB — the product media ceiling. */
export const IMAGE_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

/**
 * `POST /v1/admin/blog/posts/:id/cover/upload-url`. The post id is in the
 * path and the object key is derived server-side from it — a client-chosen
 * key is the path-traversal primitive, so there is no field for one.
 */
export const blogCoverUploadUrlRequestSchema = z
  .object({
    contentType: imageUploadContentTypeSchema,
    sizeBytes: z.number().int().positive().max(IMAGE_UPLOAD_MAX_BYTES),
  })
  .strict();

export type BlogCoverUploadUrlRequest = z.infer<typeof blogCoverUploadUrlRequestSchema>;

/** A short-lived signed PUT, the key it writes and where the object will be readable. */
export const imageUploadUrlResponseSchema = z
  .object({
    uploadUrl: z.string().url(),
    objectKey: z.string().min(1),
    publicUrl: z.string().url(),
    expiresInSeconds: z.number().int().positive(),
  })
  .strict();

export type ImageUploadUrlResponse = z.infer<typeof imageUploadUrlResponseSchema>;

/**
 * The shape of a blog cover key: `blog/{postId}/{name}.{ext}`, where the name
 * is the timestamp-plus-random stem the API mints. Exported so the API can
 * refuse a `coverObjectKey` that does not belong to the post being updated.
 */
export function isBlogCoverObjectKey(postId: string, objectKey: string): boolean {
  const prefix = `blog/${postId}/`;
  if (!objectKey.startsWith(prefix)) return false;
  return /^[A-Za-z0-9-]+\.(?:jpg|png|webp|avif)$/.test(objectKey.slice(prefix.length));
}
