import { Module } from "@nestjs/common";

import { CLOCK, systemClock } from "../auth/ports/clock.port";
import { MediaModule } from "../media/media.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ThrottlerModule } from "../throttler/throttler.module";
import { AdminBlogController } from "./admin-blog.controller";
import { BlogController } from "./blog.controller";
import { BLOG_REPOSITORY, PrismaBlogRepository } from "./blog.repository";
import { BlogService } from "./blog.service";

/**
 * BlogModule — spec 2026-09-24 §8.
 *
 * Owns blog posts end to end: the public list/detail the storefront renders,
 * the admin CRUD the dashboard drives, and the cover upload.
 *
 * Imports `MediaModule` for its signer and public-URL resolution rather than
 * loosening `MediaAsset` (which is product-bound: `productId` required, keys
 * `products/{productId}/…`). A cover is a key on the post, `blog/{postId}/…`.
 *
 * Mounts its own `/admin/*` controller, like SiteSettingsModule: the global RolesGuard is all it needs from the admin
 * graph.
 *
 * Storefront purges ride the EXISTING `storefront.revalidate` outbox topic with
 * the `blog` tag, so no new outbox consumer is registered here.
 */
@Module({
  imports: [PrismaModule, ThrottlerModule, MediaModule],
  controllers: [BlogController, AdminBlogController],
  providers: [
    BlogService,
    { provide: BLOG_REPOSITORY, useClass: PrismaBlogRepository },
    { provide: CLOCK, useValue: systemClock },
  ],
})
export class BlogModule {}
