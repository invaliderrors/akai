import "reflect-metadata";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { Prisma } from "@akai/db";
import type { ServerEnv } from "@akai/config";

import type { Clock } from "../auth/ports/clock.port";
import type { PrismaService } from "../prisma/prisma.service";
import { BatchesService } from "./batches.service";
import type { CreateBatch } from "./batches.dto";
import { CATALOG_TOPICS } from "../catalog/catalog.events";
import { REVALIDATE_TAG_PRODUCTS } from "@akai/contracts";
import { REVALIDATION_TOPIC } from "../revalidation/revalidation.types";

/**
 * Batch records and their certificates of analysis.
 *
 * WHAT IS ACTUALLY AT RISK. `attachCoa` is the one write in this module a
 * caller does not fully control the input of — the object key comes back
 * from whatever the browser uploaded to. The prefix check is the whole
 * defense against attaching an object issued for a DIFFERENT batch, so it is
 * asserted directly rather than only through the happy path.
 */

const NOW = new Date("2026-07-20T10:00:00.000Z");
const clock: Clock = { now: () => NOW };

const config = {
  S3_ENDPOINT: "http://localhost:9002",
  S3_BUCKET_COA: "akai-coa",
  S3_ACCESS_KEY_ID: "akaidev",
  S3_SECRET_ACCESS_KEY: "akaidev-secret",
} as unknown as ServerEnv;

const VARIANT_ID = "11111111-1111-4111-8111-111111111111";
const BATCH_ID = "22222222-2222-4222-8222-222222222222";

const CREATE_INPUT: CreateBatch = {
  lotCode: "LOT-2026-07",
  purityPercent: 99.42,
  testedAt: "2026-07-01T00:00:00.000Z",
  testMethod: "HPLC",
};

/** A stand-in for the Prisma client, recording what this service asked it to do. */
function fakePrisma(overrides: {
  variantExists?: boolean;
  existingBatch?: { id: string; coaObjectKey: string | null } | null;
  createThrows?: "P2002" | null;
}) {
  const {
    variantExists = true,
    existingBatch = { id: BATCH_ID, coaObjectKey: null },
    createThrows = null,
  } = overrides;

  const updates: unknown[] = [];
  const outbox: { topic: string; payload: Record<string, unknown> }[] = [];

  const client = {
      outboxMessage: {
        create: async (args: { data: { topic: string; payload: Record<string, unknown> } }) => {
          outbox.push(args.data);
          return { id: "outbox-1" };
        },
      },
      productVariant: {
        findFirst: async () => (variantExists ? { id: VARIANT_ID } : null),
      },
      batch: {
        create: async (args: { data: Record<string, unknown> }) => {
          if (createThrows === "P2002") {
            throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
              code: "P2002",
              clientVersion: "6.0.0",
            });
          }
          return {
            id: BATCH_ID,
            lotCode: args.data["lotCode"],
            purityPercent: new Prisma.Decimal(args.data["purityPercent"] as number),
            testedAt: args.data["testedAt"],
            testMethod: args.data["testMethod"],
            coaObjectKey: null,
            expiresAt: null,
          };
        },
        findUnique: async () => existingBatch,
        update: async (args: { where: { id: string }; data: { coaObjectKey: string } }) => {
          updates.push(args);
          return {
            id: args.where.id,
            lotCode: "LOT-2026-07",
            purityPercent: new Prisma.Decimal("99.42"),
            testedAt: new Date("2026-07-01T00:00:00.000Z"),
            testMethod: "HPLC",
            coaObjectKey: args.data.coaObjectKey,
            expiresAt: null,
          };
        },
      },
  };

  return {
    prisma: {
      ...client,
      // The write and its purge commit together: the callback runs against
      // the same recording client, so a throw inside rolls back BOTH.
      $transaction: async <T>(work: (tx: typeof client) => Promise<T>): Promise<T> => work(client),
    } as unknown as PrismaService,
    updates,
    outbox,
  };
}

function serviceWith(overrides: Parameters<typeof fakePrisma>[0] = {}) {
  const { prisma, updates, outbox } = fakePrisma(overrides);
  return { service: new BatchesService(prisma, config, clock), updates, outbox };
}

describe("BatchesService.createBatch", () => {
  it("refuses an unknown variant rather than creating an orphaned batch", async () => {
    const { service } = serviceWith({ variantExists: false });

    await expect(service.createBatch(VARIANT_ID, CREATE_INPUT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("creates the batch and returns the contract shape, with no COA yet", async () => {
    const { service } = serviceWith();

    const batch = await service.createBatch(VARIANT_ID, CREATE_INPUT);

    expect(batch.lotCode).toBe("LOT-2026-07");
    expect(batch.purityPercent).toBe(99.42);
    expect(batch.testMethod).toBe("HPLC");
    expect(batch.coaUrl).toBeNull();
  });

  it("turns a duplicate lot code into a clean 409, not a raw Postgres error", async () => {
    const { service } = serviceWith({ createThrows: "P2002" });

    await expect(service.createBatch(VARIANT_ID, CREATE_INPUT)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("BatchesService.createCoaUploadUrl", () => {
  it("refuses an unknown batch", async () => {
    const { service } = serviceWith({ existingBatch: null });

    await expect(
      service.createCoaUploadUrl(BATCH_ID, { sizeBytes: 1000 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("mints a key scoped to THIS batch's own prefix", async () => {
    const { service } = serviceWith();

    const result = await service.createCoaUploadUrl(BATCH_ID, { sizeBytes: 1000 });

    expect(result.objectKey.startsWith(`coa/${BATCH_ID}/`)).toBe(true);
    expect(result.objectKey.endsWith(".pdf")).toBe(true);
    expect(new URL(result.uploadUrl).pathname).toBe(`/akai-coa/${result.objectKey}`);
  });

  it("never leaks the secret access key into the URL", async () => {
    const { service } = serviceWith();

    const result = await service.createCoaUploadUrl(BATCH_ID, { sizeBytes: 1000 });

    expect(result.uploadUrl).not.toContain("akaidev-secret");
  });
});

describe("BatchesService.attachCoa", () => {
  it("refuses a key that was not issued for THIS batch — the whole defense against cross-batch attachment", async () => {
    const { service } = serviceWith();

    await expect(
      service.attachCoa(BATCH_ID, { objectKey: "coa/some-other-batch/report.pdf" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses an unknown batch even with a well-formed key", async () => {
    const { service } = serviceWith({ existingBatch: null });

    await expect(
      service.attachCoa(BATCH_ID, { objectKey: `coa/${BATCH_ID}/report.pdf` }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("records the key and returns an immediately-usable signed url", async () => {
    const { service, updates } = serviceWith();
    const objectKey = `coa/${BATCH_ID}/2026-07-20-abc123.pdf`;

    const batch = await service.attachCoa(BATCH_ID, { objectKey });

    expect(updates).toEqual([{ where: { id: BATCH_ID }, data: { coaObjectKey: objectKey } }]);
    expect(batch.coaUrl).not.toBeNull();
    expect(batch.coaUrl).toContain(objectKey);
    // The PRIVATE bucket, never the public media one.
    expect(batch.coaUrl).toContain("akai-coa");
  });
});

describe("BatchesService — storefront revalidation", () => {
  /**
   * The public payload still carries the lot record, and the page is
   * ISR-cached. The page no longer DISPLAYS batch data (purity is a fixed
   * claim, the certificate is the product's), so these purges are
   * precautionary — pinned so dropping them is a decision, not an accident.
   */
  it("enqueues a storefront purge when a batch is recorded", async () => {
    const { service, outbox } = serviceWith();

    await service.createBatch(VARIANT_ID, CREATE_INPUT);

    expect(outbox).toEqual([
      {
        topic: REVALIDATION_TOPIC,
        payload: {
          tags: [REVALIDATE_TAG_PRODUCTS],
          reason: CATALOG_TOPICS.batchRecorded,
        },
      },
    ]);
  });

  it("enqueues a storefront purge when a COA is attached", async () => {
    const { service, outbox } = serviceWith();

    await service.attachCoa(BATCH_ID, { objectKey: `coa/${BATCH_ID}/report.pdf` });

    expect(outbox).toEqual([
      {
        topic: REVALIDATION_TOPIC,
        payload: {
          tags: [REVALIDATE_TAG_PRODUCTS],
          reason: CATALOG_TOPICS.batchCoaAttached,
        },
      },
    ]);
  });

  it("enqueues nothing when the write is refused", async () => {
    const duplicate = serviceWith({ createThrows: "P2002" });
    await expect(duplicate.service.createBatch(VARIANT_ID, CREATE_INPUT)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(duplicate.outbox).toEqual([]);

    const foreignKey = serviceWith();
    await expect(
      foreignKey.service.attachCoa(BATCH_ID, { objectKey: "coa/other/report.pdf" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(foreignKey.outbox).toEqual([]);
  });
});
