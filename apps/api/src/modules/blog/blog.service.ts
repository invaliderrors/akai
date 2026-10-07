import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@akai/db";
import {
  isBlogCoverObjectKey,
  type AdminBlogPost,
  type AdminBlogPostListQuery,
  type AdminBlogPostListResponse,
  type BlogCoverUploadUrlRequest,
  type BlogPostListQuery,
  type CreateBlogPost,
  type ImageUploadUrlResponse,
  type PublicBlogPost,
  type PublicBlogPostListResponse,
  type UpdateBlogPost,
} from "@akai/contracts";
import { sanitizeRichText } from "@akai/rich-text";

import { CLOCK, type Clock } from "../auth/ports/clock.port";
import { MediaService } from "../media/media.service";
import { BlogError } from "./blog.errors";
import { BLOG_REVALIDATION_REASONS } from "./blog.events";
import { toAdminPost, toPublicPost, toPublicSummary, type CoverUrlResolver } from "./blog.mapper";
import { BLOG_REPOSITORY, type BlogPostRecord, type BlogRepository } from "./blog.repository";

/**
 * The blog — spec 2026-09-24 §8.
 *
 * PUBLIC READS SEE PUBLISHED POSTS ONLY, and that is decided in ONE place: the
 * repository's `listPublished` / `findPublishedBySlug`, which are the only
 * reads the public controller can reach. A draft has no public code path.
 *
 * BODIES ARE SANITISED ON WRITE with the same `sanitizeRichText` the product
 * description uses (D8a: the allow-list is unchanged, so no inline images).
 * The storefront sanitises again on render; the write-side pass is the
 * authoritative one and keeps stored markup honest for every other reader.
 */
@Injectable()
export class BlogService {
  private readonly coverUrl: CoverUrlResolver;

  constructor(
    @Inject(BLOG_REPOSITORY) private readonly repository: BlogRepository,
    private readonly media: MediaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.coverUrl = (objectKey) => this.media.publicUrlFor(objectKey);
  }

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  async listPublished(query: BlogPostListQuery): Promise<PublicBlogPostListResponse> {
    const page = await this.repository.listPublished({
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.rows.map((row) => toPublicSummary(row, this.coverUrl)),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }

  async getPublished(slug: string): Promise<PublicBlogPost> {
    const record = await this.repository.findPublishedBySlug(slug);
    if (record === null) throw BlogError.notFound();
    return toPublicPost(record, this.coverUrl);
  }

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  async listAdmin(query: AdminBlogPostListQuery): Promise<AdminBlogPostListResponse> {
    const page = await this.repository.listAll({
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.rows.map((row) => toAdminPost(row, this.coverUrl)),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }

  async getAdmin(id: string): Promise<AdminBlogPost> {
    return this.toAdmin(await this.repository.findById(id));
  }

  /** Always a DRAFT; `authorId` is the operator's own id, never a body field. */
  async create(input: CreateBlogPost, authorId: string | null): Promise<AdminBlogPost> {
    const record = await translateWriteError(() =>
      this.repository.create({
        slug: input.slug,
        category: input.category,
        authorId,
        title: input.title,
        excerpt: input.excerpt,
        bodyHtml: sanitizeBody(input.bodyHtml),
        metaTitle: input.metaTitle,
        metaDescription: input.metaDescription,
        coverAlt: input.coverAlt,
      }),
    );
    return toAdminPost(record, this.coverUrl);
  }

  async update(id: string, input: UpdateBlogPost): Promise<AdminBlogPost> {
    // A cover key must be one THIS post's upload URL minted. Anything else —
    // another post's cover, a product image, `../` — is refused: the key is
    // resolved to a public URL on every read, so accepting an arbitrary one
    // would let a post display any object in the bucket.
    if (
      input.coverObjectKey !== undefined &&
      input.coverObjectKey !== null &&
      !isBlogCoverObjectKey(id, input.coverObjectKey)
    ) {
      throw BlogError.validation("coverObjectKey does not belong to this post");
    }

    const record = await translateWriteError(() =>
      this.repository.update(
        id,
        {
          ...(input.slug === undefined ? {} : { slug: input.slug }),
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.coverObjectKey === undefined ? {} : { coverObjectKey: input.coverObjectKey }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.excerpt === undefined ? {} : { excerpt: input.excerpt }),
          ...(input.bodyHtml === undefined ? {} : { bodyHtml: sanitizeBody(input.bodyHtml) }),
          ...(input.metaTitle === undefined ? {} : { metaTitle: input.metaTitle }),
          ...(input.metaDescription === undefined
            ? {}
            : { metaDescription: input.metaDescription }),
          ...(input.coverAlt === undefined ? {} : { coverAlt: input.coverAlt }),
        },
        BLOG_REVALIDATION_REASONS.postUpdated,
      ),
    );
    return this.toAdmin(record);
  }

  async publish(id: string): Promise<AdminBlogPost> {
    return this.toAdmin(
      await this.repository.setStatus(
        id,
        "PUBLISHED",
        this.clock.now(),
        BLOG_REVALIDATION_REASONS.postPublished,
      ),
    );
  }

  async unpublish(id: string): Promise<AdminBlogPost> {
    return this.toAdmin(
      await this.repository.setStatus(
        id,
        "DRAFT",
        this.clock.now(),
        BLOG_REVALIDATION_REASONS.postUnpublished,
      ),
    );
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.repository.delete(id, BLOG_REVALIDATION_REASONS.postDeleted);
    if (!deleted) throw BlogError.notFound();
  }

  /**
   * A signed PUT for this post's cover, keyed `blog/{postId}/…`.
   *
   * The post must exist: signing a key for an id that is not a post would let
   * an operator park arbitrary objects under `blog/` that nothing references.
   * Recording the key on the post is a separate `update` once the bytes land —
   * the same two-step order the product gallery uses, so a failed upload never
   * leaves a post pointing at an object that 404s.
   */
  async createCoverUploadUrl(
    id: string,
    request: BlogCoverUploadUrlRequest,
  ): Promise<ImageUploadUrlResponse> {
    const record = await this.repository.findById(id);
    if (record === null) throw BlogError.notFound();
    return this.media.createBlogCoverUploadUrl(id, request.contentType);
  }

  private toAdmin(record: BlogPostRecord | null): AdminBlogPost {
    if (record === null) throw BlogError.notFound();
    return toAdminPost(record, this.coverUrl);
  }
}

/**
 * Sanitise the body. A body that sanitises to NOTHING (it was entirely
 * disallowed markup — a pasted `<script>`, an embed) is refused rather than
 * stored empty: the schema already refuses a blank body, and a body that is
 * blank after cleaning is the same half-written post.
 */
function sanitizeBody(submitted: string): string {
  const bodyHtml = sanitizeRichText(submitted).trim();
  if (bodyHtml.length === 0) {
    throw BlogError.validation("The body contains no allowed content after sanitisation");
  }
  return bodyHtml;
}

/** A duplicate slug is a 409 the operator can fix, not a 500 naming our schema. */
async function translateWriteError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw BlogError.slugTaken();
    }
    throw error;
  }
}
