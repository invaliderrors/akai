import { z } from "zod";
import { idSchema, isoDateTimeSchema, paginatedSchema, slugSchema } from "./common";

/**
 * The blog — spec 2026-09-24 §8 ("Nuestras últimas publicaciones").
 *
 * Three decisions shape every schema below:
 *
 *  - D8a: a COVER IMAGE ONLY. Post bodies go through the same `@akai/rich-text`
 *    allow-list as product descriptions, which has no `img`; inline images are
 *    a later change to that allow-list, not to these schemas.
 *  - D8b: the category is a FIXED enum, editable only by code, so the chip on a
 *    card is a catalogue label rather than whatever an operator typed.
 *  - The shop is Spanish only, so a post's copy (title, excerpt, body, meta,
 *    cover alt) sits on the post itself — there are no per-language rows.
 */

/** D8b. Mirrors the `BlogCategory` Prisma enum member-for-member. */
export const blogCategorySchema = z.enum(["DROPS", "LOOKBOOK", "STYLE_GUIDES", "NEWS"]);
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

/** A post's copy, as the platform stores and serves it. */
export const blogPostCopySchema = z
  .object({
    title: z.string().min(1).max(BLOG_TITLE_MAX),
    excerpt: z.string().max(BLOG_EXCERPT_MAX),
    bodyHtml: z.string().max(BLOG_BODY_MAX),
    metaTitle: z.string().max(BLOG_META_TITLE_MAX).nullable(),
    metaDescription: z.string().max(BLOG_META_DESCRIPTION_MAX).nullable(),
    coverAlt: z.string().max(BLOG_COVER_ALT_MAX),
  })
  .strict();

export type BlogPostCopy = z.infer<typeof blogPostCopySchema>;

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
    title: blogPostCopySchema.shape.title,
    excerpt: blogPostCopySchema.shape.excerpt,
    coverAlt: blogPostCopySchema.shape.coverAlt,
  })
  .strict();

export type PublicBlogPostSummary = z.infer<typeof publicBlogPostSummarySchema>;

/** One post in full — `/blog/[slug]`. */
export const publicBlogPostSchema = publicBlogPostSummarySchema
  .extend({
    bodyHtml: blogPostCopySchema.shape.bodyHtml,
    metaTitle: blogPostCopySchema.shape.metaTitle,
    metaDescription: blogPostCopySchema.shape.metaDescription,
  })
  .strict();

export type PublicBlogPost = z.infer<typeof publicBlogPostSchema>;

/** `GET /v1/blog/posts` — every published post, newest first. */
export const blogPostListQuerySchema = z
  .object({
    cursor: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();

export type BlogPostListQuery = z.infer<typeof blogPostListQuerySchema>;

export const publicBlogPostListResponseSchema = paginatedSchema(publicBlogPostSummarySchema);

export type PublicBlogPostListResponse = z.infer<typeof publicBlogPostListResponseSchema>;

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
  })
  .merge(blogPostCopySchema)
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
 * A post's copy on a write.
 *
 * Trimmed, and `title`/`excerpt`/`bodyHtml` are required non-blank: a card
 * with an empty excerpt or a page with an empty body is a half-written post.
 * The meta fields are optional — the page falls back to the title and the
 * excerpt.
 */
const blogPostCopyInputShape = {
  title: z.string().trim().min(1).max(BLOG_TITLE_MAX),
  excerpt: z.string().trim().min(1).max(BLOG_EXCERPT_MAX),
  bodyHtml: z.string().trim().min(1).max(BLOG_BODY_MAX),
  metaTitle: z.string().trim().max(BLOG_META_TITLE_MAX).nullable().default(null),
  metaDescription: z.string().trim().max(BLOG_META_DESCRIPTION_MAX).nullable().default(null),
  coverAlt: z.string().trim().max(BLOG_COVER_ALT_MAX).default(""),
};

export const blogPostCopyInputSchema = z.object(blogPostCopyInputShape).strict();

export type BlogPostCopyInput = z.infer<typeof blogPostCopyInputSchema>;

/**
 * Create a DRAFT. No cover and no status here: a cover key is scoped to the
 * post's id (`blog/{postId}/…`), which does not exist until this call returns,
 * and publishing is its own verb.
 */
export const createBlogPostSchema = z
  .object({
    slug: slugSchema,
    category: blogCategorySchema,
    ...blogPostCopyInputShape,
  })
  .strict();

export type CreateBlogPost = z.infer<typeof createBlogPostSchema>;

/**
 * A partial update: only the fields present change. `coverObjectKey: null`
 * removes the cover.
 */
export const updateBlogPostSchema = z
  .object({
    slug: slugSchema.optional(),
    category: blogCategorySchema.optional(),
    coverObjectKey: z.string().min(1).max(512).nullable().optional(),
    title: blogPostCopyInputShape.title.optional(),
    excerpt: blogPostCopyInputShape.excerpt.optional(),
    bodyHtml: blogPostCopyInputShape.bodyHtml.optional(),
    metaTitle: z.string().trim().max(BLOG_META_TITLE_MAX).nullable().optional(),
    metaDescription: z.string().trim().max(BLOG_META_DESCRIPTION_MAX).nullable().optional(),
    coverAlt: blogPostCopyInputShape.coverAlt.removeDefault().optional(),
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
