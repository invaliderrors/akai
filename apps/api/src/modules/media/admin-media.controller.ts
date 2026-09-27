import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../auth/guards/roles.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  createUploadUrlSchema,
  type CreateUploadUrl,
  type UploadUrlResponse,
} from "./media.dto";
import { MediaService } from "./media.service";

/**
 * Media uploads. ADMIN SURFACE ONLY — there is no public verb here and there
 * must never be one.
 *
 * A public "give me a signed upload URL" route is an open write capability into
 * our object storage: anyone could fill the bucket, and anyone could host
 * arbitrary content on our origin. That is why this controller lives under
 * `admin/` and why the guard is declared AT CLASS LEVEL, once — the same
 * reasoning `AdminProductsController` records. A method added later inherits the
 * restriction; forgetting a decorator produces a 403 in development rather than
 * an open endpoint in production.
 *
 * The API never receives the file. This route hands back a short-lived signed
 * URL and the browser PUTs directly to storage; see `MediaService` for why.
 */
@ApiTags("admin")
@Controller("admin/media")
@Roles("STAFF", "ADMIN")
export class AdminMediaController {
  constructor(private readonly media: MediaService) {}

  /**
   * Mint a signed URL for one object.
   *
   * TWO STEPS, not one, and the split is the whole design: this route authorises
   * an upload, and `POST /v1/admin/products/:id/media` records the result. That
   * second route already existed and already takes an `{objectKey, url, width,
   * height, alt, sortOrder}` — it simply had no way to be given a key, because
   * nothing in the platform produced one. Keeping them separate means an upload
   * that fails midway leaves an orphaned object rather than a half-attached
   * media row on a live product.
   *
   * 200, not 201: nothing is created. A capability is issued.
   */
  @Post("upload-url")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Issue a short-lived signed URL for a direct-to-storage image upload",
  })
  createUploadUrl(
    @Body(new ZodValidationPipe(createUploadUrlSchema)) body: CreateUploadUrl,
  ): UploadUrlResponse {
    return this.media.createUploadUrl(body);
  }
}
