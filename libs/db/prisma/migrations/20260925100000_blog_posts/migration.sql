-- Blog posts and their per-locale copy (spec 2026-09-24 §8).
--
-- Generated with `prisma migrate diff` from the previous schema, then extended
-- with the two CHECK constraints at the end that Prisma cannot express — the
-- same pattern as `affiliate_link_slug_format`.

-- CreateEnum
CREATE TYPE "BlogPostStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "BlogCategory" AS ENUM ('PEPTIDES', 'RESEARCH_GUIDES', 'NEWS');

-- CreateTable
CREATE TABLE "blog_post" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "status" "BlogPostStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "coverObjectKey" VARCHAR(512),
    "category" "BlogCategory" NOT NULL,
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blog_post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_post_translation" (
    "id" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "excerpt" VARCHAR(500) NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "metaTitle" VARCHAR(200),
    "metaDescription" VARCHAR(320),
    "coverAlt" VARCHAR(300) NOT NULL DEFAULT '',

    CONSTRAINT "blog_post_translation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blog_post_slug_key" ON "blog_post"("slug");

-- CreateIndex
CREATE INDEX "blog_post_status_publishedAt_idx" ON "blog_post"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "blog_post_authorId_idx" ON "blog_post"("authorId");

-- CreateIndex
CREATE INDEX "blog_post_translation_locale_idx" ON "blog_post_translation"("locale");

-- CreateIndex
CREATE UNIQUE INDEX "blog_post_translation_postId_locale_key" ON "blog_post_translation"("postId", "locale");

-- AddForeignKey
ALTER TABLE "blog_post" ADD CONSTRAINT "blog_post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_post_translation" ADD CONSTRAINT "blog_post_translation_postId_fkey" FOREIGN KEY ("postId") REFERENCES "blog_post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The slug is the public URL (`/blog/{slug}`): lowercase kebab-case, the same
-- rule `slugSchema` in @akai/contracts enforces at the boundary.
ALTER TABLE "blog_post"
  ADD CONSTRAINT "blog_post_slug_format"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- A PUBLISHED post always has a publication date. The public list orders by
-- it; a NULL there would sort a live post to an arbitrary end of the list.
ALTER TABLE "blog_post"
  ADD CONSTRAINT "blog_post_published_has_date"
  CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);
