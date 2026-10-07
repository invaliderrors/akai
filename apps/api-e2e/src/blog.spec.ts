import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import {
  REVALIDATE_TAG_BLOG,
  adminBlogPostSchema,
  errorEnvelopeSchema,
  imageUploadUrlResponseSchema,
  publicBlogPostListResponseSchema,
  publicBlogPostSchema,
  type Role,
} from "@akai/contracts";
import { createLogger } from "@akai/observability";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX } from "../../api/src/common/api-paths";
import { AllExceptionsFilter } from "../../api/src/common/filters/all-exceptions.filter";
import { AccessTokenService } from "../../api/src/modules/auth/crypto/access-token.service";
import { REVALIDATION_TOPIC } from "../../api/src/modules/revalidation/revalidation.types";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * THE BLOG, AGAINST REAL POSTGRES AND THE REAL HTTP STACK (spec 2026-09-24 §8).
 *
 * What only this level proves:
 *   - the public reads see PUBLISHED posts only, through the real global guards;
 *   - D8c: a Spanish-only post is absent from `?locale=en` and its detail 404s
 *     there, while a bilingual one appears in both;
 *   - the unique slug is a 409 CONFLICT envelope, not a 500;
 *   - every publish/update/unpublish/delete writes a `storefront.revalidate`
 *     outbox row carrying the `blog` tag, in the same transaction;
 *   - the admin surface refuses anonymous (401) and customer (403) callers.
 */

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "pub_test_unit",
  WOMPI_PRIVATE_KEY: "prv_test_unit",
  WOMPI_INTEGRITY_SECRET: "test_integrity_unit",
  WOMPI_EVENTS_SECRET: "test_events_unit",
  EMAIL_TRANSPORT: "smtp",
  SMTP_URL: "smtp://localhost:1025",
  EMAIL_FROM: "no-reply@example.com",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "akai-media",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  STOREFRONT_URL: "http://localhost:3000",
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
};

const BODY_ES = {
  locale: "es",
  title: "Cómo combinar un oversize",
  excerpt: "Una guía rápida de estilo.",
  bodyHtml: "<h2>Origen</h2><p>Texto<script>alert(1)</script></p>",
};

const BODY_EN = {
  locale: "en",
  title: "How to style an oversized tee",
  excerpt: "A quick styling guide.",
  bodyHtml: "<p>Text</p>",
};

describe.skipIf(!isDockerAvailable())("Blog — public visibility, D8c and admin CRUD", () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let savedEnv: NodeJS.ProcessEnv;
  let staffToken = "";
  let customerToken = "";

  async function tokenFor(role: Role, email: string): Promise<string> {
    const customer = await db.prisma.customer.create({ data: { email, role } });
    const session = await db.prisma.session.create({
      data: {
        customerId: customer.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        // A fresh 2FA assertion: operator routes require one.
        twoFactorAssertedAt: new Date(),
      },
    });
    return app.get(AccessTokenService).issue({
      customerId: customer.id,
      sessionId: session.id,
      role,
    }).token;
  }

  beforeAll(async () => {
    savedEnv = process.env;
    db = await startTestDatabase();
    process.env = { ...TEST_ENV, DATABASE_URL: db.databaseUrl, DIRECT_DATABASE_URL: db.databaseUrl };
    resetServerConfigCache();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>(new ExpressAdapter());
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    app.useGlobalFilters(
      new AllExceptionsFilter(createLogger({ level: "silent", nodeEnv: "test", serviceName: "api-e2e" }), false),
    );
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    process.env = savedEnv;
    resetServerConfigCache();
  });

  beforeEach(async () => {
    await db.reset();
    staffToken = await tokenFor("STAFF", "staff@example.com");
    customerToken = await tokenFor("CUSTOMER", "customer@example.com");
  });

  const http = () => request(app.getHttpServer());

  async function createPost(slug: string, translations: readonly object[]) {
    const response = await http()
      .post(`/${API_GLOBAL_PREFIX}/admin/blog/posts`)
      .set("authorization", `Bearer ${staffToken}`)
      .send({ slug, category: "STYLE_GUIDES", translations });
    expect(response.status).toBe(201);
    return adminBlogPostSchema.parse(response.body);
  }

  async function publish(id: string) {
    const response = await http()
      .post(`/${API_GLOBAL_PREFIX}/admin/blog/posts/${id}/publish`)
      .set("authorization", `Bearer ${staffToken}`);
    expect(response.status).toBe(201);
    return adminBlogPostSchema.parse(response.body);
  }

  async function publicList(query: Record<string, string> = {}) {
    const response = await http().get(`/${API_GLOBAL_PREFIX}/blog/posts`).query(query);
    expect(response.status).toBe(200);
    return publicBlogPostListResponseSchema.parse(response.body);
  }

  async function blogPurges(): Promise<string[]> {
    const rows = await db.prisma.outboxMessage.findMany({
      where: { topic: REVALIDATION_TOPIC },
      orderBy: { createdAt: "asc" },
    });
    return rows.flatMap((row) => {
      const payload = row.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
      const tags = "tags" in payload ? payload["tags"] : undefined;
      const reason = "reason" in payload ? payload["reason"] : undefined;
      return Array.isArray(tags) && tags.includes(REVALIDATE_TAG_BLOG) && typeof reason === "string"
        ? [reason]
        : [];
    });
  }

  it("keeps a draft off every public read, and shows it once published", async () => {
    const draft = await createPost("como-combinar-un-oversize", [BODY_ES]);
    expect(draft.status).toBe("DRAFT");
    expect(draft.publishedAt).toBeNull();
    // Sanitised on write.
    expect(draft.translations[0]?.bodyHtml).toBe("<h2>Origen</h2><p>Texto</p>");

    expect((await publicList()).items).toHaveLength(0);
    const hidden = await http().get(`/${API_GLOBAL_PREFIX}/blog/posts/como-combinar-un-oversize`);
    expect(hidden.status).toBe(404);

    const published = await publish(draft.id);
    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).not.toBeNull();

    const list = await publicList();
    expect(list.items.map((item) => item.slug)).toEqual(["como-combinar-un-oversize"]);
    const detail = await http().get(`/${API_GLOBAL_PREFIX}/blog/posts/como-combinar-un-oversize`);
    expect(detail.status).toBe(200);
    expect(publicBlogPostSchema.parse(detail.body).translations[0]?.title).toBe(BODY_ES.title);
  });

  it("D8c: a Spanish-only post is absent from the English list and 404s in English", async () => {
    const spanishOnly = await createPost("solo-espanol", [BODY_ES]);
    const bilingual = await createPost("bilingue", [BODY_ES, BODY_EN]);
    await publish(spanishOnly.id);
    await publish(bilingual.id);

    expect((await publicList({ locale: "en" })).items.map((item) => item.slug)).toEqual(["bilingue"]);
    expect((await publicList({ locale: "es" })).items.map((item) => item.slug).sort()).toEqual([
      "bilingue",
      "solo-espanol",
    ]);

    const missing = await http()
      .get(`/${API_GLOBAL_PREFIX}/blog/posts/solo-espanol`)
      .query({ locale: "en" });
    expect(missing.status).toBe(404);
    const present = await http()
      .get(`/${API_GLOBAL_PREFIX}/blog/posts/bilingue`)
      .query({ locale: "en" });
    expect(present.status).toBe(200);

    // Withdrawing the English version takes the post out of /en.
    const withdrawn = await http()
      .patch(`/${API_GLOBAL_PREFIX}/admin/blog/posts/${bilingual.id}`)
      .set("authorization", `Bearer ${staffToken}`)
      .send({ translations: [BODY_ES] });
    expect(withdrawn.status).toBe(200);
    expect((await publicList({ locale: "en" })).items).toHaveLength(0);
  });

  it("orders newest first and pages with a cursor", async () => {
    const first = await createPost("primero", [BODY_ES]);
    await publish(first.id);
    const second = await createPost("segundo", [BODY_ES]);
    await publish(second.id);

    const pageOne = await publicList({ limit: "1" });
    expect(pageOne.items.map((item) => item.slug)).toEqual(["segundo"]);
    expect(pageOne.hasMore).toBe(true);
    expect(pageOne.nextCursor).not.toBeNull();

    const pageTwo = await publicList({ limit: "1", cursor: pageOne.nextCursor ?? "" });
    expect(pageTwo.items.map((item) => item.slug)).toEqual(["primero"]);
    expect(pageTwo.hasMore).toBe(false);
  });

  it("refuses a duplicate slug with a CONFLICT envelope", async () => {
    await createPost("repetido", [BODY_ES]);

    const duplicate = await http()
      .post(`/${API_GLOBAL_PREFIX}/admin/blog/posts`)
      .set("authorization", `Bearer ${staffToken}`)
      .send({ slug: "repetido", category: "NEWS", translations: [BODY_ES] });

    expect(duplicate.status).toBe(409);
    expect(errorEnvelopeSchema.parse(duplicate.body).error.code).toBe("CONFLICT");
  });

  it("enqueues a blog purge on update, publish, unpublish and delete — not on create", async () => {
    const post = await createPost("purgas", [BODY_ES]);
    expect(await blogPurges()).toEqual([]);

    await http()
      .patch(`/${API_GLOBAL_PREFIX}/admin/blog/posts/${post.id}`)
      .set("authorization", `Bearer ${staffToken}`)
      .send({ category: "NEWS" })
      .expect(200);
    await publish(post.id);
    await http()
      .post(`/${API_GLOBAL_PREFIX}/admin/blog/posts/${post.id}/unpublish`)
      .set("authorization", `Bearer ${staffToken}`)
      .expect(201);
    expect((await publicList()).items).toHaveLength(0);
    await http()
      .delete(`/${API_GLOBAL_PREFIX}/admin/blog/posts/${post.id}`)
      .set("authorization", `Bearer ${staffToken}`)
      .expect(204);

    expect(await blogPurges()).toEqual([
      "blog.post.updated",
      "blog.post.published",
      "blog.post.unpublished",
      "blog.post.deleted",
    ]);
    await http()
      .get(`/${API_GLOBAL_PREFIX}/admin/blog/posts/${post.id}`)
      .set("authorization", `Bearer ${staffToken}`)
      .expect(404);
  });

  it("signs a cover upload under blog/{postId}/ and resolves the stored key publicly", async () => {
    const post = await createPost("con-portada", [BODY_ES]);

    const signed = await http()
      .post(`/${API_GLOBAL_PREFIX}/admin/blog/posts/${post.id}/cover/upload-url`)
      .set("authorization", `Bearer ${staffToken}`)
      .send({ contentType: "image/webp", sizeBytes: 12_000 });
    expect(signed.status).toBe(200);
    const upload = imageUploadUrlResponseSchema.parse(signed.body);
    expect(upload.objectKey.startsWith(`blog/${post.id}/`)).toBe(true);

    const foreign = await http()
      .patch(`/${API_GLOBAL_PREFIX}/admin/blog/posts/${post.id}`)
      .set("authorization", `Bearer ${staffToken}`)
      .send({ coverObjectKey: "products/x/hero.webp" });
    expect(foreign.status).toBe(400);

    await http()
      .patch(`/${API_GLOBAL_PREFIX}/admin/blog/posts/${post.id}`)
      .set("authorization", `Bearer ${staffToken}`)
      .send({ coverObjectKey: upload.objectKey })
      .expect(200);
    await publish(post.id);

    const [item] = (await publicList()).items;
    expect(item?.coverUrl).toBe(upload.publicUrl);
  });

  it("refuses the admin surface to anonymous (401) and customer (403) callers", async () => {
    const post = await createPost("privado", [BODY_ES]);
    const base = `/${API_GLOBAL_PREFIX}/admin/blog/posts`;

    await http().get(base).expect(401);
    await http().post(base).send({ slug: "x", category: "NEWS", translations: [BODY_ES] }).expect(401);
    await http().post(`${base}/${post.id}/publish`).expect(401);

    await http().get(base).set("authorization", `Bearer ${customerToken}`).expect(403);
    await http()
      .post(`${base}/${post.id}/publish`)
      .set("authorization", `Bearer ${customerToken}`)
      .expect(403);
    await http()
      .delete(`${base}/${post.id}`)
      .set("authorization", `Bearer ${customerToken}`)
      .expect(403);

    // Nothing the refused callers attempted landed.
    const unchanged = await db.prisma.blogPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(unchanged.status).toBe("DRAFT");
  });
});
