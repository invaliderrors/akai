import type {
  AdminBlogPost,
  PublicBlogPost,
  PublicBlogPostSummary,
} from "@akai/contracts";

import type { BlogPostRecord } from "./blog.repository";

/**
 * Repository record → wire shapes.
 *
 * `coverUrl` is resolved by the caller's function (`MediaService.publicUrlFor`)
 * so a stored key and the URL the upload reported can never disagree about the
 * origin or the bucket. The public shapes drop the key itself, the status and
 * the author: a shopper needs none of them, and a field that is not in the
 * payload cannot leak.
 */
export type CoverUrlResolver = (objectKey: string) => string;

/**
 * The public shapes need a publication date; only published posts reach them,
 * and the database refuses a published row without one
 * (`blog_post_published_has_date`). A record without one here is a caller bug.
 */
function publishedAtOf(record: BlogPostRecord): string {
  if (record.publishedAt === null) {
    throw new Error(`Blog post ${record.id} has no publication date`);
  }
  return record.publishedAt.toISOString();
}

function coverUrlOf(record: BlogPostRecord, resolve: CoverUrlResolver): string | null {
  return record.coverObjectKey === null ? null : resolve(record.coverObjectKey);
}

export function toPublicSummary(
  record: BlogPostRecord,
  resolve: CoverUrlResolver,
): PublicBlogPostSummary {
  return {
    id: record.id,
    slug: record.slug,
    category: record.category,
    publishedAt: publishedAtOf(record),
    coverUrl: coverUrlOf(record, resolve),
    title: record.title,
    excerpt: record.excerpt,
    coverAlt: record.coverAlt,
  };
}

export function toPublicPost(record: BlogPostRecord, resolve: CoverUrlResolver): PublicBlogPost {
  return {
    ...toPublicSummary(record, resolve),
    bodyHtml: record.bodyHtml,
    metaTitle: record.metaTitle,
    metaDescription: record.metaDescription,
  };
}

export function toAdminPost(record: BlogPostRecord, resolve: CoverUrlResolver): AdminBlogPost {
  return {
    id: record.id,
    slug: record.slug,
    status: record.status,
    category: record.category,
    publishedAt: record.publishedAt === null ? null : record.publishedAt.toISOString(),
    coverObjectKey: record.coverObjectKey,
    coverUrl: coverUrlOf(record, resolve),
    authorId: record.authorId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    title: record.title,
    excerpt: record.excerpt,
    bodyHtml: record.bodyHtml,
    metaTitle: record.metaTitle,
    metaDescription: record.metaDescription,
    coverAlt: record.coverAlt,
  };
}
