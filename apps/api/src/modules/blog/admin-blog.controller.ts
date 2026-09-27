import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  adminBlogPostListQuerySchema,
  blogCoverUploadUrlRequestSchema,
  createBlogPostSchema,
  idSchema,
  updateBlogPostSchema,
  type AdminBlogPost,
  type AdminBlogPostListQuery,
  type AdminBlogPostListResponse,
  type BlogCoverUploadUrlRequest,
  type CreateBlogPost,
  type ImageUploadUrlResponse,
  type UpdateBlogPost,
} from "@akai/contracts";

import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Roles } from "../auth/guards/roles.guard";
import { CurrentUser, type Principal } from "../auth/security/principal";
import { BlogService } from "./blog.service";

/**
 * Blog admin: CRUD, publish/unpublish and the cover upload.
 *
 * `@Roles` DECLARED ONCE AT CLASS LEVEL — the `AdminCategoriesController`
 * rule: a handler added later inherits STAFF/ADMIN by default, so forgetting a
 * decorator cannot ship an unauthenticated write. `admin-blog.controller.test.ts`
 * discovers every handler by reflection and proves it.
 */
@ApiTags("admin")
@Controller("admin/blog/posts")
@Roles("STAFF", "ADMIN")
export class AdminBlogController {
  constructor(private readonly blog: BlogService) {}

  @Get()
  @ApiOperation({ summary: "Every blog post, drafts included" })
  async list(
    @Query(new ZodValidationPipe(adminBlogPostListQuerySchema)) query: AdminBlogPostListQuery,
  ): Promise<AdminBlogPostListResponse> {
    return this.blog.listAdmin(query);
  }

  @Get(":id")
  async get(@Param("id", new ZodValidationPipe(idSchema)) id: string): Promise<AdminBlogPost> {
    return this.blog.getAdmin(id);
  }

  @Post()
  @ApiOperation({ summary: "Create a draft blog post" })
  async create(
    @Body(new ZodValidationPipe(createBlogPostSchema)) body: CreateBlogPost,
    @CurrentUser() user: Principal,
  ): Promise<AdminBlogPost> {
    return this.blog.create(body, user.customerId);
  }

  @Patch(":id")
  async update(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateBlogPostSchema)) body: UpdateBlogPost,
  ): Promise<AdminBlogPost> {
    return this.blog.update(id, body);
  }

  @Post(":id/publish")
  async publish(@Param("id", new ZodValidationPipe(idSchema)) id: string): Promise<AdminBlogPost> {
    return this.blog.publish(id);
  }

  @Post(":id/unpublish")
  async unpublish(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<AdminBlogPost> {
    return this.blog.unpublish(id);
  }

  /** Hard delete — nothing references a post. 204, no body. */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id", new ZodValidationPipe(idSchema)) id: string): Promise<void> {
    await this.blog.remove(id);
  }

  /**
   * A signed PUT for this post's cover, keyed `blog/{postId}/…`. The object key
   * is minted server-side; there is no request field for one.
   */
  @Post(":id/cover/upload-url")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Issue a signed URL for a direct-to-storage cover upload" })
  async createCoverUploadUrl(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(blogCoverUploadUrlRequestSchema)) body: BlogCoverUploadUrlRequest,
  ): Promise<ImageUploadUrlResponse> {
    return this.blog.createCoverUploadUrl(id, body);
  }
}
