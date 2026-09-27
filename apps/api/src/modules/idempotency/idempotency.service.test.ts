import "reflect-metadata";
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Prisma } from "@akai/db";
import { IdempotencyService } from "./idempotency.service";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Idempotency under retry.
 *
 * The scenarios here are the ones that actually occur: a proxy times out on a
 * slow bulk import and the dashboard retries; two tabs submit at once; a key is
 * reused by accident with a different payload.
 */

interface StoredRecord {
  key: string;
  userId: string;
  route: string;
  requestHash: string;
  responseSnapshot: unknown;
  statusCode: number | null;
  expiresAt: Date;
}

/**
 * An in-memory stand-in for the idempotency_record table that enforces the real
 * PRIMARY KEY (key, userId, route) — including throwing Prisma's P2002 on a
 * duplicate INSERT. Without that behaviour the test would prove nothing: the
 * whole mechanism rests on the unique violation.
 */
function buildFakePrisma(): { prisma: PrismaService; rows: Map<string, StoredRecord> } {
  const rows = new Map<string, StoredRecord>();
  const keyOf = (identity: { key: string; userId: string; route: string }): string =>
    `${identity.key}|${identity.userId}|${identity.route}`;

  const prisma = {
    idempotencyRecord: {
      create: async ({ data }: { data: StoredRecord }) => {
        const id = keyOf(data);
        if (rows.has(id)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "6.0.0",
          });
        }
        rows.set(id, { ...data, responseSnapshot: null, statusCode: null });
        return data;
      },
      findUnique: async ({
        where,
      }: {
        where: { key_userId_route: { key: string; userId: string; route: string } };
      }) => rows.get(keyOf(where.key_userId_route)) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { key: string; userId: string; route: string };
        data: { responseSnapshot: unknown; statusCode: number };
      }) => {
        const existing = rows.get(keyOf(where));
        if (existing !== undefined) {
          existing.responseSnapshot = data.responseSnapshot;
          existing.statusCode = data.statusCode;
        }
        return { count: existing === undefined ? 0 : 1 };
      },
      deleteMany: async ({ where }: { where: { key: string; userId: string; route: string } }) => {
        const existing = rows.get(keyOf(where));
        if (existing !== undefined && existing.responseSnapshot === null) {
          rows.delete(keyOf(where));
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  } as unknown as PrismaService;

  return { prisma, rows };
}

const reportSchema = z.object({ created: z.number(), slug: z.string() }).strict();

function execution(
  overrides: Partial<{
    key: string;
    userId: string;
    request: unknown;
    handler: () => Promise<{ created: number; slug: string }>;
  }> = {},
) {
  return {
    key: overrides.key ?? "key-1",
    userId: overrides.userId ?? "admin-1",
    route: "POST /admin/products/import",
    request: overrides.request ?? { products: [{ slug: "hoodie-kumo" }] },
    responseSchema: reportSchema,
    handler: overrides.handler ?? (async () => ({ created: 1, slug: "hoodie-kumo" })),
  };
}

describe("IdempotencyService", () => {
  it("runs the handler once and replays the stored result on retry", async () => {
    const { prisma } = buildFakePrisma();
    const service = new IdempotencyService(prisma);
    const handler = vi.fn(async () => ({ created: 1, slug: "hoodie-kumo" }));

    const first = await service.execute(execution({ handler }));
    const second = await service.execute(execution({ handler }));

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.value).toEqual(first.value);
    // The point of the whole service: a retried bulk import must not import twice.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects the same key used with a DIFFERENT body", async () => {
    const { prisma } = buildFakePrisma();
    const service = new IdempotencyService(prisma);

    await service.execute(execution({ request: { products: ["a"] } }));

    // Replaying the first response here would hand back a result for a request
    // that was never run — silently, and looking entirely successful.
    await expect(
      service.execute(execution({ request: { products: ["b"] } })),
    ).rejects.toThrow(ConflictException);
  });

  it("treats key order in the body as irrelevant", async () => {
    const { prisma } = buildFakePrisma();
    const service = new IdempotencyService(prisma);
    const handler = vi.fn(async () => ({ created: 1, slug: "hoodie-kumo" }));

    await service.execute(execution({ request: { a: 1, b: 2 }, handler }));
    const replay = await service.execute(execution({ request: { b: 2, a: 1 }, handler }));

    // Two semantically identical bodies that serialise with different key order
    // are the same request. Hashing raw JSON would make a retry from a different
    // client library look like a conflicting one.
    expect(replay.replayed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("scopes keys per actor, so two admins may reuse the same key value", async () => {
    const { prisma } = buildFakePrisma();
    const service = new IdempotencyService(prisma);
    const handler = vi.fn(async () => ({ created: 1, slug: "hoodie-kumo" }));

    await service.execute(execution({ userId: "admin-1", handler }));
    const other = await service.execute(execution({ userId: "admin-2", handler }));

    // One admin must never receive another's import report.
    expect(other.replayed).toBe(false);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("releases the reservation when the handler throws, so a retry can proceed", async () => {
    const { prisma } = buildFakePrisma();
    const service = new IdempotencyService(prisma);

    const failing = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    await expect(service.execute(execution({ handler: failing }))).rejects.toThrow(
      "database unavailable",
    );

    // A transient failure must not permanently burn the key. Without the
    // release, the admin's retry would 409 forever and the only fix would be
    // deleting a row by hand.
    const retry = await service.execute(execution());
    expect(retry.replayed).toBe(false);
    expect(retry.value).toEqual({ created: 1, slug: "hoodie-kumo" });
  });

  it("409s a concurrent retry while the first request is still running", async () => {
    const { prisma } = buildFakePrisma();
    const service = new IdempotencyService(prisma);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = service.execute(
      execution({
        handler: async () => {
          await gate;
          return { created: 1, slug: "hoodie-kumo" };
        },
      }),
    );

    // Second request arrives before the first has stored its snapshot.
    await expect(service.execute(execution())).rejects.toThrow(ConflictException);

    release?.();
    await expect(slow).resolves.toMatchObject({ replayed: false });
  });

  it("validates a replayed snapshot instead of trusting stored JSON", async () => {
    const { prisma, rows } = buildFakePrisma();
    const service = new IdempotencyService(prisma);

    await service.execute(execution());

    // Simulate a schema change between the original write and the replay.
    const stored = rows.get("key-1|admin-1|POST /admin/products/import");
    expect(stored).toBeDefined();
    if (stored !== undefined) {
      stored.responseSnapshot = { unexpected: "shape" };
    }

    // Failing loudly beats handing the caller a shape it cannot handle.
    await expect(service.execute(execution())).rejects.toThrow();
  });

  it("produces a stable hash for equal requests and a different one otherwise", () => {
    const { prisma } = buildFakePrisma();
    const service = new IdempotencyService(prisma);

    expect(service.hashRequest({ a: 1 })).toBe(service.hashRequest({ a: 1 }));
    expect(service.hashRequest({ a: 1 })).not.toBe(service.hashRequest({ a: 2 }));
    // Nested key order must not matter either.
    expect(service.hashRequest({ x: { p: 1, q: 2 } })).toBe(
      service.hashRequest({ x: { q: 2, p: 1 } }),
    );
  });
});
