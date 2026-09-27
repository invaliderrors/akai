import { describe, expect, it } from "vitest";
import type { ServerEnv } from "@akai/config";
import { Prisma } from "@akai/db";
import {
  adminBlogPostSchema,
  createBlogPostSchema,
  publicBlogPostListResponseSchema,
  publicBlogPostSchema,
  type BlogPostStatus,
  type Locale,
} from "@akai/contracts";

import type { Clock } from "../auth/ports/clock.port";
import { MediaService } from "../media/media.service";
import { BlogError } from "./blog.errors";
import { BLOG_REVALIDATION_REASONS, type BlogRevalidationReason } from "./blog.events";
import type {
  BlogPage,
  BlogPostPatch,
  BlogPostRecord,
  BlogRepository,
  NewBlogPost,
} from "./blog.repository";
import { BlogService } from "./blog.service";

const NOW = new Date("2026-09-24T10:00:00.000Z");
const clock: Clock = { now: () => NOW };

const config = {
  S3_ENDPOINT: "http://localhost:9002",
  S3_BUCKET: "akai-media",
  S3_ACCESS_KEY_ID: "akaidev",
  S3_SECRET_ACCESS_KEY: "akaidev-secret",
} as unknown as ServerEnv;

const POST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_ID = "8d9e6679-7425-40de-944b-e07fc1f90ae8";
const AUTHOR_ID = "11111111-1111-4111-8111-111111111111";

function translation(locale: Locale, overrides: Partial<BlogPostRecord["translations"][number]> = {}) {
  return {
    locale,
    title: `Title ${locale}`,
    excerpt: `Excerpt ${locale}`,
    bodyHtml: "<p>Body</p>",
    metaTitle: null,
    metaDescription: null,
    coverAlt: "",
    ...overrides,
  };
}

function record(overrides: Partial<BlogPostRecord> = {}): BlogPostRecord {
  return {
    id: POST_ID,
    slug: "como-combinar-un-oversize",
    status: "PUBLISHED",
    category: "STYLE_GUIDES",
    publishedAt: new Date("2026-09-20T10:00:00.000Z"),
    coverObjectKey: null,
    authorId: AUTHOR_ID,
    createdAt: new Date("2026-09-19T10:00:00.000Z"),
    updatedAt: new Date("2026-09-19T10:00:00.000Z"),
    translations: [translation("es")],
    ...overrides,
  };
}

interface Call {
  readonly method: string;
  readonly reason?: BlogRevalidationReason;
  readonly patch?: BlogPostPatch;
  readonly input?: NewBlogPost;
  readonly status?: BlogPostStatus;
}

/**
 * An in-memory double that mimics the adapter's contract closely enough to
 * test the SERVICE: which read a public call reaches, what is sanitised before
 * it is stored, and which writes carry a purge reason. The real filtering SQL
 * is proven against Postgres in `apps/api-e2e/src/blog.spec.ts`.
 */
class FakeBlogRepository implements BlogRepository {
  readonly calls: Call[] = [];
  constructor(public posts: BlogPostRecord[] = [], private readonly failWith?: unknown) {}

  listPublished(query: { locale?: Locale | undefined; limit: number }): Promise<BlogPage> {
    this.calls.push({ method: "listPublished" });
    const rows = this.posts.filter(
      (post) =>
        post.status === "PUBLISHED" &&
        (query.locale === undefined || post.translations.some((t) => t.locale === query.locale)),
    );
    return Promise.resolve({ rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit, nextCursor: null });
  }

  findPublishedBySlug(slug: string): Promise<BlogPostRecord | null> {
    this.calls.push({ method: "findPublishedBySlug" });
    return Promise.resolve(
      this.posts.find((post) => post.slug === slug && post.status === "PUBLISHED") ?? null,
    );
  }

  listAll(): Promise<BlogPage> {
    this.calls.push({ method: "listAll" });
    return Promise.resolve({ rows: this.posts, hasMore: false, nextCursor: null });
  }

  findById(id: string): Promise<BlogPostRecord | null> {
    return Promise.resolve(this.posts.find((post) => post.id === id) ?? null);
  }

  create(input: NewBlogPost): Promise<BlogPostRecord> {
    this.calls.push({ method: "create", input });
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(
      record({
        status: "DRAFT",
        publishedAt: null,
        slug: input.slug,
        authorId: input.authorId,
        translations: input.translations,
      }),
    );
  }

  update(id: string, patch: BlogPostPatch, reason: BlogRevalidationReason): Promise<BlogPostRecord | null> {
    this.calls.push({ method: "update", patch, reason });
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    const existing = this.posts.find((post) => post.id === id);
    if (existing === undefined) return Promise.resolve(null);
    return Promise.resolve({
      ...existing,
      ...(patch.slug === undefined ? {} : { slug: patch.slug }),
      ...(patch.coverObjectKey === undefined ? {} : { coverObjectKey: patch.coverObjectKey }),
      ...(patch.translations === undefined ? {} : { translations: patch.translations }),
    });
  }

  setStatus(
    id: string,
    status: BlogPostStatus,
    now: Date,
    reason: BlogRevalidationReason,
  ): Promise<BlogPostRecord | null> {
    this.calls.push({ method: "setStatus", status, reason });
    const existing = this.posts.find((post) => post.id === id);
    if (existing === undefined) return Promise.resolve(null);
    return Promise.resolve({ ...existing, status, publishedAt: existing.publishedAt ?? now });
  }

  delete(id: string, reason: BlogRevalidationReason): Promise<boolean> {
    this.calls.push({ method: "delete", reason });
    return Promise.resolve(this.posts.some((post) => post.id === id));
  }
}

function serviceWith(repository: FakeBlogRepository): BlogService {
  return new BlogService(repository, new MediaService(config, clock), clock);
}

describe("BlogService — public reads", () => {
  it("lists only published posts, in the published contract's shape", async () => {
    const repository = new FakeBlogRepository([
      record(),
      record({ id: OTHER_ID, slug: "borrador", status: "DRAFT", publishedAt: null }),
    ]);

    const result = await serviceWith(repository).listPublished({ limit: 12 });

    expect(publicBlogPostListResponseSchema.parse(result)).toEqual(result);
    expect(result.items.map((item) => item.slug)).toEqual(["como-combinar-un-oversize"]);
  });

  it("filters by locale — a Spanish-only post is absent from the English list (D8c)", async () => {
    const repository = new FakeBlogRepository([
      record(),
      record({
        id: OTHER_ID,
        slug: "bilingual",
        translations: [translation("es"), translation("en")],
      }),
    ]);

    const english = await serviceWith(repository).listPublished({ limit: 12, locale: "en" });

    expect(english.items.map((item) => item.slug)).toEqual(["bilingual"]);
  });

  it("resolves the cover key to the public media URL and never exposes the key", async () => {
    const key = `blog/${POST_ID}/2026-09-24T10-00-00-000Z-abcd.webp`;
    const repository = new FakeBlogRepository([record({ coverObjectKey: key })]);

    const [item] = (await serviceWith(repository).listPublished({ limit: 12 })).items;

    expect(item?.coverUrl).toBe(`http://localhost:9002/akai-media/${key}`);
    expect(JSON.stringify(item)).not.toContain('"coverObjectKey"');
  });

  it("serves a published post by slug with its full copy", async () => {
    const repository = new FakeBlogRepository([record()]);

    const post = await serviceWith(repository).getPublished("como-combinar-un-oversize", undefined);

    expect(publicBlogPostSchema.parse(post)).toEqual(post);
    expect(post.translations[0]?.bodyHtml).toBe("<p>Body</p>");
  });

  it("404s a draft — the public read never reaches an unpublished post", async () => {
    const repository = new FakeBlogRepository([record({ status: "DRAFT", publishedAt: null })]);

    await expect(serviceWith(repository).getPublished("como-combinar-un-oversize", undefined)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("404s a post in a locale it has no translation for (D8c)", async () => {
    const repository = new FakeBlogRepository([record()]);
    const service = serviceWith(repository);

    await expect(service.getPublished("como-combinar-un-oversize", "en")).rejects.toBeInstanceOf(BlogError);
    await expect(service.getPublished("como-combinar-un-oversize", "es")).resolves.toMatchObject({
      slug: "como-combinar-un-oversize",
    });
  });
});

describe("BlogService — admin writes", () => {
  const createInput = createBlogPostSchema.parse({
    slug: "nuevo",
    category: "NEWS",
    translations: [
      {
        locale: "es",
        title: "Nuevo",
        excerpt: "Resumen",
        bodyHtml: '<p onclick="steal()">Hola<script>alert(1)</script></p>',
      },
    ],
  });

  it("creates a DRAFT attributed to the operator, with the body sanitised", async () => {
    const repository = new FakeBlogRepository();

    const created = await serviceWith(repository).create(createInput, AUTHOR_ID);

    expect(adminBlogPostSchema.parse(created)).toEqual(created);
    expect(created.status).toBe("DRAFT");
    expect(created.authorId).toBe(AUTHOR_ID);
    const stored = repository.calls.find((call) => call.method === "create")?.input;
    expect(stored?.translations[0]?.bodyHtml).toBe("<p>Hola</p>");
  });

  it("refuses a body that sanitises to nothing", async () => {
    const repository = new FakeBlogRepository();
    const input = createBlogPostSchema.parse({
      ...createInput,
      translations: [{ ...createInput.translations[0], bodyHtml: "<script>alert(1)</script>" }],
    });

    await expect(serviceWith(repository).create(input, AUTHOR_ID)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(repository.calls).toHaveLength(0);
  });

  it("turns a duplicate slug (P2002) into CONFLICT, on create and on update", async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["slug"] },
    });
    const repository = new FakeBlogRepository([record()], duplicate);
    const service = serviceWith(repository);

    await expect(service.create(createInput, AUTHOR_ID)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.update(POST_ID, { slug: "taken" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("sanitises the bodies of an update's replacement translations", async () => {
    const repository = new FakeBlogRepository([record()]);

    await serviceWith(repository).update(POST_ID, {
      translations: createInput.translations,
    });

    const patch = repository.calls.find((call) => call.method === "update")?.patch;
    expect(patch?.translations?.[0]?.bodyHtml).toBe("<p>Hola</p>");
  });

  it("accepts a cover key minted for this post and refuses any other", async () => {
    const repository = new FakeBlogRepository([record()]);
    const service = serviceWith(repository);
    const own = `blog/${POST_ID}/2026-09-24T10-00-00-000Z-abcd.png`;

    await expect(service.update(POST_ID, { coverObjectKey: own })).resolves.toMatchObject({
      coverObjectKey: own,
    });
    for (const foreign of [
      `blog/${OTHER_ID}/2026-09-24T10-00-00-000Z-abcd.png`,
      `products/${POST_ID}/hero.png`,
      `blog/${POST_ID}/../../secrets.png`,
    ]) {
      await expect(service.update(POST_ID, { coverObjectKey: foreign })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }
    await expect(service.update(POST_ID, { coverObjectKey: null })).resolves.toMatchObject({
      coverObjectKey: null,
    });
  });

  it("404s an update, publish, unpublish or delete of a post that does not exist", async () => {
    const service = serviceWith(new FakeBlogRepository());

    await expect(service.update(POST_ID, { slug: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.publish(POST_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.unpublish(POST_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.remove(POST_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.getAdmin(POST_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("BlogService — storefront revalidation", () => {
  it("purges on update, publish, unpublish and delete, each with its own reason", async () => {
    const repository = new FakeBlogRepository([record({ status: "DRAFT", publishedAt: null })]);
    const service = serviceWith(repository);

    await service.update(POST_ID, { category: "NEWS" });
    await service.publish(POST_ID);
    await service.unpublish(POST_ID);
    await service.remove(POST_ID);

    expect(repository.calls.map((call) => call.reason)).toEqual([
      BLOG_REVALIDATION_REASONS.postUpdated,
      BLOG_REVALIDATION_REASONS.postPublished,
      BLOG_REVALIDATION_REASONS.postUnpublished,
      BLOG_REVALIDATION_REASONS.postDeleted,
    ]);
  });

  it("publishes with the clock's time when the post has never been published", async () => {
    const repository = new FakeBlogRepository([record({ status: "DRAFT", publishedAt: null })]);

    const published = await serviceWith(repository).publish(POST_ID);

    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).toBe(NOW.toISOString());
  });

  it("does not purge on create — a new post is a draft no page shows", async () => {
    const repository = new FakeBlogRepository();

    await serviceWith(repository).create(
      createBlogPostSchema.parse({
        slug: "draft",
        category: "NEWS",
        translations: [{ locale: "es", title: "T", excerpt: "E", bodyHtml: "<p>B</p>" }],
      }),
      null,
    );

    expect(repository.calls.every((call) => call.reason === undefined)).toBe(true);
  });
});

describe("BlogService.createCoverUploadUrl", () => {
  it("signs a key under blog/{postId}/ for an existing post", async () => {
    const service = serviceWith(new FakeBlogRepository([record()]));

    const signed = await service.createCoverUploadUrl(POST_ID, {
      contentType: "image/webp",
      sizeBytes: 1000,
    });

    expect(signed.objectKey.startsWith(`blog/${POST_ID}/`)).toBe(true);
  });

  it("refuses to sign for a post that does not exist", async () => {
    const service = serviceWith(new FakeBlogRepository());

    await expect(
      service.createCoverUploadUrl(POST_ID, { contentType: "image/png", sizeBytes: 1000 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
