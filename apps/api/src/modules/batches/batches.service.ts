import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Prisma } from "@akai/db";
import type { ServerEnv } from "@akai/config";
import { REVALIDATE_TAG_PRODUCTS, type Batch } from "@akai/contracts";

import { PrismaService } from "../prisma/prisma.service";
import { SERVER_CONFIG } from "../config/config.module";
import { CLOCK, type Clock } from "../auth/ports/clock.port";
import { presignGetUrl, presignPutUrl } from "../media/s3-presigner";
import { CATALOG_TOPICS, type CatalogTopic } from "../catalog/catalog.events";
import { REVALIDATION_TOPIC } from "../revalidation/revalidation.types";
import type { AttachCoa, CoaUploadUrlResponse, CreateBatch, CreateCoaUploadUrl } from "./batches.dto";

const S3_REGION = "us-east-1";

/** Mirrors `MediaService`'s upload TTL: long enough for a slow connection, short enough that a captured URL is worthless soon after. */
const UPLOAD_URL_TTL_SECONDS = 600;

/** Mirrors `ProductsService`'s read TTL — see that constant for the reasoning. */
const READ_URL_TTL_SECONDS = 3600;

/**
 * Batch (lot) records and their certificates of analysis.
 *
 * SELF-CONTAINED, unlike `MediaModule`: that module signs uploads only and
 * leaves recording the asset to CatalogModule, because a catalog write route
 * already existed before MediaModule did and splitting kept that route's
 * `{objectKey, url, ...}` shape stable. No such route predates this module —
 * there is no other owner of `batch` to split against — so this module owns
 * the whole lifecycle: creating a lot, minting a signed upload URL for its
 * COA, and recording the key once the upload succeeds.
 *
 * THE BYTES NEVER TRANSIT THE API, same reasoning as media: a PDF PUTs
 * directly to `S3_BUCKET_COA` with a short-lived signed URL.
 *
 * THE CLIENT DOES NOT CHOOSE THE OBJECT KEY, same reasoning as media: it is
 * derived from the batch id, a timestamp and 8 random bytes, and `attachCoa`
 * REFUSES a key that does not start with this batch's own prefix — otherwise
 * an admin session that can create batches could attach (and later read,
 * through the signed GET this module never even needs to gate) an object
 * uploaded under a DIFFERENT batch's key.
 */
@Injectable()
export class BatchesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async createBatch(variantId: string, input: CreateBatch): Promise<Batch> {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, deletedAt: null },
      select: { id: true },
    });
    if (variant === null) {
      throw new NotFoundException("Variant not found");
    }

    try {
      const batch = await this.prisma.$transaction(async (tx) => {
        const created = await tx.batch.create({
          data: {
            variantId,
            lotCode: input.lotCode,
            purityPercent: input.purityPercent,
            testedAt: new Date(input.testedAt),
            testMethod: input.testMethod,
          },
        });
        await this.enqueueRevalidation(tx, CATALOG_TOPICS.batchRecorded);
        return created;
      });
      return this.mapBatch(batch);
    } catch (error: unknown) {
      // `@@unique([variantId, lotCode])`: this variant already has a batch
      // under this exact lot code. A clean 409 beats a raw Postgres
      // constraint-violation message reaching an operator.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(
          `This variant already has a batch recorded under lot "${input.lotCode}"`,
        );
      }
      throw error;
    }
  }

  async createCoaUploadUrl(
    batchId: string,
    input: CreateCoaUploadUrl,
  ): Promise<CoaUploadUrlResponse> {
    const batch = await this.prisma.batch.findUnique({
      where: { id: batchId },
      select: { id: true },
    });
    if (batch === null) {
      throw new NotFoundException("Batch not found");
    }

    // Declared size only rejects an obviously-oversized request before a URL
    // is issued — `createCoaUploadUrlSchema` already bounds it at 10 MB, so
    // this is defense in depth, not the only check.
    void input.sizeBytes;

    const now = this.clock.now();
    const objectKey = this.buildObjectKey(batchId, now);

    const uploadUrl = presignPutUrl({
      endpoint: this.config.S3_ENDPOINT,
      bucket: this.config.S3_BUCKET_COA,
      objectKey,
      region: S3_REGION,
      accessKeyId: this.config.S3_ACCESS_KEY_ID,
      secretAccessKey: this.config.S3_SECRET_ACCESS_KEY,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      now,
    });

    return { uploadUrl, objectKey, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
  }

  async attachCoa(batchId: string, input: AttachCoa): Promise<Batch> {
    const expectedPrefix = `coa/${batchId}/`;
    if (!input.objectKey.startsWith(expectedPrefix)) {
      throw new BadRequestException(
        "This object key was not issued for this batch — request a fresh upload URL",
      );
    }

    const existing = await this.prisma.batch.findUnique({ where: { id: batchId } });
    if (existing === null) {
      throw new NotFoundException("Batch not found");
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.batch.update({
        where: { id: batchId },
        data: { coaObjectKey: input.objectKey },
      });
      await this.enqueueRevalidation(tx, CATALOG_TOPICS.batchCoaAttached);
      return row;
    });

    return this.mapBatch(updated);
  }

  /**
   * Purge the storefront's product pages, in the SAME transaction as the
   * write — the pattern `ProductsService.enqueueRevalidation` documents.
   *
   * PRECAUTIONARY NOW. The page used to show the newest batch's purity and
   * certificate; it no longer reads batches at all (purity is a fixed claim,
   * the certificate is the product's). The purge is kept because the public
   * payload still carries the lot record, and a stale cache is the one thing
   * it costs nothing to rule out.
   *
   * Only the PRODUCTS tag: a batch changes no category.
   */
  private async enqueueRevalidation(
    tx: Prisma.TransactionClient,
    reason: CatalogTopic,
  ): Promise<void> {
    await tx.outboxMessage.create({
      data: {
        topic: REVALIDATION_TOPIC,
        payload: { tags: [REVALIDATE_TAG_PRODUCTS], reason },
      },
    });
  }

  /**
   * `objectKey` is unguessable (batch id + timestamp + random suffix), but
   * unguessable is not the same as authorised — the signature is what a
   * bucket with no anonymous-download policy actually checks.
   */
  private buildObjectKey(batchId: string, now: Date): string {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const suffix = randomBytes(8).toString("hex");
    return `coa/${batchId}/${stamp}-${suffix}.pdf`;
  }

  private signCoaUrl = (objectKey: string): string =>
    presignGetUrl({
      endpoint: this.config.S3_ENDPOINT,
      bucket: this.config.S3_BUCKET_COA,
      objectKey,
      region: S3_REGION,
      accessKeyId: this.config.S3_ACCESS_KEY_ID,
      secretAccessKey: this.config.S3_SECRET_ACCESS_KEY,
      expiresInSeconds: READ_URL_TTL_SECONDS,
      now: this.clock.now(),
    });

  private mapBatch(row: {
    id: string;
    lotCode: string;
    purityPercent: Prisma.Decimal;
    testedAt: Date;
    testMethod: string;
    coaObjectKey: string | null;
    expiresAt: Date | null;
  }): Batch {
    return {
      id: row.id,
      lotCode: row.lotCode,
      purityPercent: row.purityPercent.toNumber(),
      testedAt: row.testedAt.toISOString(),
      testMethod: row.testMethod,
      // Signed fresh for this response, same as a catalog read — so an admin
      // who just attached a COA sees a working link immediately, without
      // this module ever storing (or needing to store) a URL anywhere.
      coaUrl: row.coaObjectKey === null ? null : this.signCoaUrl(row.coaObjectKey),
      expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    };
  }
}
