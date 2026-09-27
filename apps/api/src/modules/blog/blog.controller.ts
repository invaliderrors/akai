import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  blogPostDetailQuerySchema,
  blogPostListQuerySchema,
  slugSchema,
  type BlogPostDetailQuery,
  type BlogPostListQuery,
  type PublicBlogPost,
  type PublicBlogPostListResponse,
} from "@akai/contracts";

import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { THROTTLE_RULES, Throttle } from "../throttler/throttle.decorator";
import { ThrottleGuard } from "../throttler/throttle.guard";
import { BlogService } from "./blog.service";

/**
 * The public blog. Read-only and unauthenticated — writes live on
 * `AdminBlogController`, in a different file behind a class-level role guard,
 * so "is this endpoint public?" is answered by which file it is in (the rule
 * the catalog and categories follow).
 *
 * Throttled with the catalog's read budget: the storefront's home page, `/blog`,
 * every post page and the sitemap all read here, and an ISR revalidation can
 * burst several of them at once.
 */
@ApiTags("blog")
@Controller("blog/posts")
export class BlogController {
  constructor(private readonly blog: BlogService) {}

  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get()
  @ApiOperation({ summary: "List published blog posts, newest first" })
  async list(
    @Query(new ZodValidationPipe(blogPostListQuerySchema)) query: BlogPostListQuery,
  ): Promise<PublicBlogPostListResponse> {
    return this.blog.listPublished(query);
  }

  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get(":slug")
  @ApiOperation({ summary: "One published blog post by slug" })
  async get(
    @Param("slug", new ZodValidationPipe(slugSchema)) slug: string,
    @Query(new ZodValidationPipe(blogPostDetailQuerySchema)) query: BlogPostDetailQuery,
  ): Promise<PublicBlogPost> {
    return this.blog.getPublished(slug, query.locale);
  }
}
