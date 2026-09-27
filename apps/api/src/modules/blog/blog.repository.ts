import { Injectable } from "@nestjs/common";
import { Prisma } from "@akai/db";
import {
  REVALIDATE_TAG_BLOG,
  type BlogCategory,
  type BlogPostStatus,
  type BlogPostTranslationInput,
  type Locale,
} from "@akai/contracts";

import { PrismaService } from "../prisma/prisma.service";
import { REVALIDATION_TOPIC } from "../revalidation/revalidation.types";
import type { BlogRevalidationReason } from "./blog.events";

/**
 * The blog persistence seam.
 *
 * A port, like CATEGORIES_REPOSITORY, so `BlogService`'s rules — sanitising,
 * cover-key ownership, error translation, which writes purge the storefront —
 * are unit-testable against an in-memory double. What only Postgres can prove
 * (published-only visibility, the locale filter, the unique slug, the outbox
 * row landing in the same transaction) is proven against a real database in
 * `apps/api-e2e/src/blog.spec.ts`.
 *
 * EVERY WRITE ENQUEUES ITS STOREFRONT PURGE IN THE SAME TRANSACTION, exactly as
 * `ProductsService.enqueueRevalidation` does and for the same reason: a purge
 * lost to a crash between the write and the enqueue is a stale page nobody will
 * ever notice. The reason travels as a parameter so the service decides WHY and
 * the adapter guarantees WHEN.
 */
export interface BlogTranslationRecord {
  readonly locale: Locale;
  readonly title: string;
  readonly excerpt: string;
  readonly bodyHtml: string;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly coverAlt: string;
}

export interface BlogPostRecord {
  readonly id: string;
  readonly slug: string;
  readonly status: BlogPostStatus;
  readonly category: BlogCategory;
  readonly publishedAt: Date | null;
  readonly coverObjectKey: string | null;
  readonly authorId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly translations: readonly BlogTranslationRecord[];
}

export interface BlogPage {
  readonly rows: readonly BlogPostRecord[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface NewBlogPost {
  readonly slug: string;
  readonly category: BlogCategory;
  readonly authorId: string | null;
  readonly translations: readonly BlogPostTranslationInput[];
}

export interface BlogPostPatch {
  readonly slug?: string;
  readonly category?: BlogCategory;
  readonly coverObjectKey?: string | null;
  /** Full replacement of the translation set when present. */
  readonly translations?: readonly BlogPostTranslationInput[];
}

export interface BlogRepository {
  /** PUBLISHED only, newest first; with `locale`, only posts translated into it. */
  listPublished(query: {
    readonly locale?: Locale | undefined;
    readonly cursor?: string | undefined;
    readonly limit: number;
  }): Promise<BlogPage>;
  /** A PUBLISHED post by slug, or null. Drafts are invisible here. */
  findPublishedBySlug(slug: string): Promise<BlogPostRecord | null>;
  /** Every post, drafts included, newest-created first. */
  listAll(query: {
    readonly status?: BlogPostStatus | undefined;
    readonly cursor?: string | undefined;
    readonly limit: number;
  }): Promise<BlogPage>;
  findById(id: string): Promise<BlogPostRecord | null>;
  /** Creates a DRAFT. Throws Prisma P2002 on a duplicate slug. */
  create(input: NewBlogPost): Promise<BlogPostRecord>;
  /** Null when the post does not exist. */
  update(
    id: string,
    patch: BlogPostPatch,
    reason: BlogRevalidationReason,
  ): Promise<BlogPostRecord | null>;
  /**
   * Publish or unpublish. `publishedAt` is stamped on the FIRST publish only
   * (COALESCE), so a republish keeps the post's original date.
   */
  setStatus(
    id: string,
    status: BlogPostStatus,
    now: Date,
    reason: BlogRevalidationReason,
  ): Promise<BlogPostRecord | null>;
  /** False when the post did not exist. */
  delete(id: string, reason: BlogRevalidationReason): Promise<boolean>;
}

export const BLOG_REPOSITORY = Symbol("BLOG_REPOSITORY");

const INCLUDE_TRANSLATIONS = {
  translations: { orderBy: { locale: "asc" } },
} as const satisfies Prisma.BlogPostInclude;

type BlogPostRow = Prisma.BlogPostGetPayload<{ include: typeof INCLUDE_TRANSLATIONS }>;

@Injectable()
export class PrismaBlogRepository implements BlogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listPublished(query: {
    readonly locale?: Locale | undefined;
    readonly cursor?: string | undefined;
    readonly limit: number;
  }): Promise<BlogPage> {
    const where: Prisma.BlogPostWhereInput = {
      status: "PUBLISHED",
      ...(query.locale === undefined ? {} : { translations: { some: { locale: query.locale } } }),
    };

    // `id` breaks ties between posts published in the same millisecond, so the
    // order — and therefore the cursor — is total.
    const rows = await this.prisma.blogPost.findMany({
      where,
      include: INCLUDE_TRANSLATIONS,
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
    });

    return toPage(rows, query.limit);
  }

  async findPublishedBySlug(slug: string): Promise<BlogPostRecord | null> {
    const row = await this.prisma.blogPost.findFirst({
      where: { slug, status: "PUBLISHED" },
      include: INCLUDE_TRANSLATIONS,
    });
    return row === null ? null : toRecord(row);
  }

  async listAll(query: {
    readonly status?: BlogPostStatus | undefined;
    readonly cursor?: string | undefined;
    readonly limit: number;
  }): Promise<BlogPage> {
    const rows = await this.prisma.blogPost.findMany({
      where: query.status === undefined ? {} : { status: query.status },
      include: INCLUDE_TRANSLATIONS,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
    });

    return toPage(rows, query.limit);
  }

  async findById(id: string): Promise<BlogPostRecord | null> {
    const row = await this.prisma.blogPost.findUnique({
      where: { id },
      include: INCLUDE_TRANSLATIONS,
    });
    return row === null ? null : toRecord(row);
  }

  /**
   * No purge: a new post is always a DRAFT, and a draft is on no storefront
   * page. The purge happens when it is published.
   */
  async create(input: NewBlogPost): Promise<BlogPostRecord> {
    const row = await this.prisma.blogPost.create({
      data: {
        slug: input.slug,
        category: input.category,
        authorId: input.authorId,
        translations: { create: input.translations.map(toTranslationData) },
      },
      include: INCLUDE_TRANSLATIONS,
    });
    return toRecord(row);
  }

  async update(
    id: string,
    patch: BlogPostPatch,
    reason: BlogRevalidationReason,
  ): Promise<BlogPostRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.blogPost.findUnique({ where: { id }, select: { id: true } });
      if (existing === null) return null;

      if (patch.translations !== undefined) {
        // Full replacement: a locale left out of the set is withdrawn (D8c).
        await tx.blogPostTranslation.deleteMany({ where: { postId: id } });
        await tx.blogPostTranslation.createMany({
          data: patch.translations.map((translation) => ({
            postId: id,
            ...toTranslationData(translation),
          })),
        });
      }

      const row = await tx.blogPost.update({
        where: { id },
        data: {
          ...(patch.slug === undefined ? {} : { slug: patch.slug }),
          ...(patch.category === undefined ? {} : { category: patch.category }),
          ...(patch.coverObjectKey === undefined ? {} : { coverObjectKey: patch.coverObjectKey }),
          // Touch the row even for a translations-only edit, so `updatedAt`
          // reflects the change an operator just made.
          updatedAt: new Date(),
        },
        include: INCLUDE_TRANSLATIONS,
      });

      await enqueuePurge(tx, reason);
      return toRecord(row);
    });
  }

  async setStatus(
    id: string,
    status: BlogPostStatus,
    now: Date,
    reason: BlogRevalidationReason,
  ): Promise<BlogPostRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.blogPost.findUnique({
        where: { id },
        select: { publishedAt: true },
      });
      if (existing === null) return null;

      const row = await tx.blogPost.update({
        where: { id },
        data: {
          status,
          ...(status === "PUBLISHED" && existing.publishedAt === null ? { publishedAt: now } : {}),
        },
        include: INCLUDE_TRANSLATIONS,
      });

      await enqueuePurge(tx, reason);
      return toRecord(row);
    });
  }

  async delete(id: string, reason: BlogRevalidationReason): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.blogPost.deleteMany({ where: { id } });
      if (deleted.count === 0) return false;
      await enqueuePurge(tx, reason);
      return true;
    });
  }
}

/**
 * One `storefront.revalidate` row for the blog tag, inside the caller's
 * transaction. Same topic and payload shape as the catalog's purge, so the
 * existing `RevalidationOutboxHandler` delivers it with no new consumer.
 */
async function enqueuePurge(
  tx: Prisma.TransactionClient,
  reason: BlogRevalidationReason,
): Promise<void> {
  await tx.outboxMessage.create({
    data: {
      topic: REVALIDATION_TOPIC,
      payload: { tags: [REVALIDATE_TAG_BLOG], reason },
    },
  });
}

function toTranslationData(translation: BlogPostTranslationInput): {
  locale: Locale;
  title: string;
  excerpt: string;
  bodyHtml: string;
  metaTitle: string | null;
  metaDescription: string | null;
  coverAlt: string;
} {
  return {
    locale: translation.locale,
    title: translation.title,
    excerpt: translation.excerpt,
    bodyHtml: translation.bodyHtml,
    metaTitle: translation.metaTitle,
    metaDescription: translation.metaDescription,
    coverAlt: translation.coverAlt,
  };
}

function toPage(rows: readonly BlogPostRow[], limit: number): BlogPage {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    rows: page.map(toRecord),
    hasMore,
    nextCursor: hasMore && last !== undefined ? last.id : null,
  };
}

function toRecord(row: BlogPostRow): BlogPostRecord {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    category: row.category,
    publishedAt: row.publishedAt,
    coverObjectKey: row.coverObjectKey,
    authorId: row.authorId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    translations: row.translations.map((translation) => ({
      locale: translation.locale,
      title: translation.title,
      excerpt: translation.excerpt,
      bodyHtml: translation.bodyHtml,
      metaTitle: translation.metaTitle,
      metaDescription: translation.metaDescription,
      coverAlt: translation.coverAlt,
    })),
  };
}
