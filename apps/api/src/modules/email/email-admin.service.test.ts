import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { emailEventSchema } from "@akai/contracts";
import { PrismaService } from "../prisma/prisma.service";
import { EmailAdminService } from "./email-admin.service";
import { listEmailEventsQuerySchema } from "./dto/email-admin.dto";

interface Row {
  id: string;
  recipient: string;
  templateKey: string;
  status: string;
  providerMessageId: string | null;
  orderId: string | null;
  error: string | null;
  attempts: number;
  sentAt: Date | null;
  createdAt: Date;
}

function row(index: number, overrides: Partial<Row> = {}): Row {
  return {
    id: `0000000${index}-0000-4000-8000-000000000000`.slice(-36),
    recipient: "marta@example.com",
    templateKey: "order-confirmation",
    status: "SENT",
    providerMessageId: `provider-${index}`,
    orderId: "11111111-1111-4111-8111-111111111111",
    error: null,
    attempts: 1,
    sentAt: new Date("2026-07-20T10:00:00.000Z"),
    createdAt: new Date("2026-07-20T10:00:00.000Z"),
    ...overrides,
  };
}

interface FindManyArgs {
  take: number;
  cursor?: { id: string };
  skip?: number;
  where: Record<string, unknown>;
}

class FakePrisma {
  rows: Row[] = [];
  suppressionRows: { email: string; reason: string; createdAt: Date }[] = [];
  lastFindManyArgs: FindManyArgs | null = null;

  readonly emailEvent = {
    findMany: async (args: FindManyArgs): Promise<Row[]> => {
      this.lastFindManyArgs = args;
      const start =
        args.cursor === undefined
          ? 0
          : this.rows.findIndex((candidate) => candidate.id === args.cursor?.id) +
            (args.skip ?? 0);
      return this.rows.slice(start, start + args.take);
    },
    findUnique: async (args: { where: { id: string } }): Promise<Row | null> =>
      this.rows.find((candidate) => candidate.id === args.where.id) ?? null,
  };

  readonly emailSuppression = {
    findMany: async (): Promise<{ email: string; reason: string; createdAt: Date }[]> =>
      this.suppressionRows,
    deleteMany: async (args: {
      where: { email: string };
    }): Promise<{ count: number }> => {
      const before = this.suppressionRows.length;
      this.suppressionRows = this.suppressionRows.filter(
        (candidate) => candidate.email !== args.where.email,
      );
      return { count: before - this.suppressionRows.length };
    },
  };
}

async function build(): Promise<{ service: EmailAdminService; prisma: FakePrisma }> {
  const prisma = new FakePrisma();
  const moduleRef = await Test.createTestingModule({
    providers: [EmailAdminService, { provide: PrismaService, useValue: prisma }],
  }).compile();

  return { service: moduleRef.get(EmailAdminService), prisma };
}

describe("EmailAdminService — listing", () => {
  let prisma: FakePrisma;
  let service: EmailAdminService;

  beforeEach(async () => {
    ({ service, prisma } = await build());
    prisma.rows = [row(1), row(2), row(3)];
  });

  it("returns a schema-valid wire shape", async () => {
    const page = await service.list(listEmailEventsQuerySchema.parse({}));

    // Parsing the RESPONSE catches DB/contract drift here, in a test, rather
    // than as a malformed field in the dashboard.
    for (const item of page.items) {
      expect(emailEventSchema.safeParse(item).success).toBe(true);
    }
    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("reports hasMore and a cursor by over-fetching one row", async () => {
    const page = await service.list(listEmailEventsQuerySchema.parse({ limit: "2" }));

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(page.items[1]?.id);
    // take = limit + 1 is the probe; without it hasMore requires a COUNT query.
    expect(prisma.lastFindManyArgs?.take).toBe(3);
  });

  it("uses cursor pagination, never OFFSET", async () => {
    await service.list(
      listEmailEventsQuerySchema.parse({ cursor: row(1).id, limit: "2" }),
    );

    // OFFSET double-counts or skips rows when writes land between pages — for
    // an email log that means a failure silently vanishing from the list.
    expect(prisma.lastFindManyArgs?.cursor).toEqual({ id: row(1).id });
    expect(prisma.lastFindManyArgs?.skip).toBe(1);
  });

  it("only filters on the fields that were supplied", async () => {
    await service.list(listEmailEventsQuerySchema.parse({ status: "FAILED" }));

    expect(prisma.lastFindManyArgs?.where).toEqual({ status: "FAILED" });
  });

  it("passes every supplied filter through", async () => {
    await service.list(
      listEmailEventsQuerySchema.parse({
        status: "FAILED",
        templateKey: "order-confirmation",
        recipient: "Marta@Example.com",
      }),
    );

    expect(prisma.lastFindManyArgs?.where).toEqual({
      status: "FAILED",
      templateKey: "order-confirmation",
      // Lower-cased by emailSchema so it matches the citext column.
      recipient: "marta@example.com",
    });
  });
});

describe("EmailAdminService — single event", () => {
  it("returns the event", async () => {
    const { service, prisma } = await build();
    prisma.rows = [row(1, { status: "FAILED", error: "boom", sentAt: null })];

    const event = await service.get(prisma.rows[0]?.id ?? "");

    expect(event.status).toBe("FAILED");
    expect(event.error).toBe("boom");
    expect(event.sentAt).toBeNull();
  });

  it("404s rather than returning null", async () => {
    const { service } = await build();

    await expect(
      service.get("99999999-9999-4999-8999-999999999999"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("EmailAdminService — suppressions", () => {
  it("lists suppressions with ISO timestamps", async () => {
    const { service, prisma } = await build();
    prisma.suppressionRows = [
      {
        email: "bounced@example.com",
        reason: "hard_bounce",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ];

    const entries = await service.listSuppressions(100);

    expect(entries).toEqual([
      {
        email: "bounced@example.com",
        reason: "hard_bounce",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
  });

  it("lifts a suppression", async () => {
    const { service, prisma } = await build();
    prisma.suppressionRows = [
      {
        email: "bounced@example.com",
        reason: "hard_bounce",
        createdAt: new Date(),
      },
    ];

    await service.removeSuppression("bounced@example.com");

    expect(prisma.suppressionRows).toHaveLength(0);
  });

  it("404s when lifting a suppression that does not exist", async () => {
    const { service } = await build();

    // Reporting success for a no-op would let an operator believe they had
    // fixed a delivery problem they had not touched.
    await expect(
      service.removeSuppression("never@example.com"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("listEmailEventsQuerySchema", () => {
  it("rejects unknown keys instead of dropping them", () => {
    // These values build a Prisma `where`; a silently-accepted extra key is how
    // an unintended filter reaches a query.
    expect(
      listEmailEventsQuerySchema.safeParse({ orderBy: "id", limit: 10 }).success,
    ).toBe(false);
  });

  it("coerces limit from a query string and clamps the range", () => {
    expect(listEmailEventsQuerySchema.parse({ limit: "50" }).limit).toBe(50);
    expect(listEmailEventsQuerySchema.parse({}).limit).toBe(25);
    expect(listEmailEventsQuerySchema.safeParse({ limit: "5000" }).success).toBe(false);
    expect(listEmailEventsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("rejects an unknown status or template key", () => {
    expect(listEmailEventsQuerySchema.safeParse({ status: "PENDING" }).success).toBe(
      false,
    );
    expect(
      listEmailEventsQuerySchema.safeParse({ templateKey: "newsletter" }).success,
    ).toBe(false);
  });
});
