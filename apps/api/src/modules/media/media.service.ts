import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { ServerEnv } from "@akai/config";

import { SERVER_CONFIG } from "../config/config.module";
import { CLOCK, type Clock } from "../auth/ports/clock.port";
import {
  CONTENT_TYPE_EXTENSIONS,
  type CreateUploadUrl,
  type UploadContentType,
  type UploadUrlResponse,
} from "./media.dto";
import { presignPutUrl } from "./s3-presigner";

/**
 * Region the bucket is addressed in.
 *
 * A CONSTANT, not config, and that is a deliberate scope decision rather than an
 * oversight: `libs/config` is outside this change's ownership, and its
 * `.env.example` conformance test would fail on a key added to only one of the
 * two. `us-east-1` is MinIO's default and the S3 global default. Moving it to
 * `S3_REGION` in validated config is a followUp, and it must move to BOTH the
 * schema and `.env.example` in one commit.
 */
const S3_REGION = "us-east-1";

/**
 * How long a signed upload URL is good for.
 *
 * Ten minutes: long enough for a slow connection to push a 15 MB image, short
 * enough that a URL captured from a browser's network tab is worthless by the
 * time anyone acts on it. A presigned URL is a bearer capability to write one
 * object, so its lifetime IS its blast radius.
 */
const UPLOAD_URL_TTL_SECONDS = 600;

/**
 * Direct-to-S3 media uploads.
 *
 * WHAT WAS MISSING, and it was visible on every page: `MediaModule` was an empty
 * `@Module({})`, so the only way to attach an image was
 * `POST /v1/admin/products/:id/media` — which takes an ALREADY-HOSTED
 * `{objectKey, url, …}` and does not accept a file. There was no route in the
 * platform that produced a hosted object, so every seeded product had
 * `media: []` and every storefront product card rendered a text fallback.
 *
 * THE BYTES NEVER TRANSIT THE API. The client PUTs directly to object storage
 * with a short-lived signed URL. Streaming uploads through a Nest handler would
 * put a 15 MB body in the API's memory, hold a request thread for the duration
 * of a mobile upload, and make the API's own timeout the upload size limit.
 *
 * THE CLIENT DOES NOT CHOOSE THE KEY. It is derived here from the product id, a
 * timestamp and 8 random bytes. A caller-supplied key is a path-traversal
 * primitive (`../../`) and an overwrite primitive (clobbering another product's
 * hero image), and the signature would faithfully authorise both.
 */
@Injectable()
export class MediaService {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  createUploadUrl(request: CreateUploadUrl): UploadUrlResponse {
    return this.signUpload(`products/${request.productId}`, request.contentType);
  }

  /**
   * A signed upload for a blog post's COVER image, keyed
   * `blog/{postId}/{timestamp}-{random}.{ext}`.
   *
   * A sibling of `createUploadUrl`, not a loosening of it: `MediaAsset.productId`
   * is required and product media keys are `products/{productId}/…`, and a blog
   * cover is neither a product nor a gallery row. Same bucket, same whitelist
   * (the caller's schema is `imageUploadContentTypeSchema`), same TTL, same
   * server-derived key — only the prefix differs. The caller is responsible for
   * having checked the post exists; this only signs.
   */
  createBlogCoverUploadUrl(postId: string, contentType: UploadContentType): UploadUrlResponse {
    return this.signUpload(`blog/${postId}`, contentType);
  }

  /**
   * Where an object in the public media bucket is readable.
   *
   * Public so a stored KEY (a blog cover's `coverObjectKey`) resolves to its URL
   * at read time through the exact function the upload itself used — the two
   * can never disagree about the origin or the bucket.
   */
  publicUrlFor(objectKey: string): string {
    return this.publicUrl(objectKey);
  }

  private signUpload(prefix: string, contentType: UploadContentType): UploadUrlResponse {
    const now = this.clock.now();
    const objectKey = this.buildObjectKey(prefix, contentType, now);

    const uploadUrl = presignPutUrl({
      endpoint: this.config.S3_ENDPOINT,
      bucket: this.config.S3_BUCKET,
      objectKey,
      region: S3_REGION,
      accessKeyId: this.config.S3_ACCESS_KEY_ID,
      secretAccessKey: this.config.S3_SECRET_ACCESS_KEY,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      now,
    });

    return {
      uploadUrl,
      objectKey,
      publicUrl: this.publicUrl(objectKey),
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  /**
   * `{prefix}/{timestamp}-{random}.{ext}` — `products/{productId}` or `blog/{postId}`.
   *
   * The product id prefix makes a bucket listing navigable and makes a lifecycle
   * rule ("purge media for deleted products") expressible as a prefix. The
   * random suffix is what makes the key unguessable and collision-free: a
   * predictable key would let anyone holding one signed URL guess the location
   * of every other product's imagery.
   */
  private buildObjectKey(prefix: string, contentType: UploadContentType, now: Date): string {
    const extension = CONTENT_TYPE_EXTENSIONS[contentType];
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const suffix = randomBytes(8).toString("hex");

    return `${prefix}/${stamp}-${suffix}.${extension}`;
  }

  /**
   * Where the object will be readable once uploaded.
   *
   * Built from the SAME endpoint and bucket the URL was signed against, so the
   * two can never disagree. In production this is fronted by a CDN; the origin
   * form is correct either way and the CDN rewrite is a deployment concern.
   */
  private publicUrl(objectKey: string): string {
    const origin = this.config.S3_ENDPOINT.replace(/\/+$/, "");
    return `${origin}/${this.config.S3_BUCKET}/${objectKey}`;
  }
}
