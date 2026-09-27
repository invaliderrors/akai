import "reflect-metadata";
import { describe, expect, it, vi, type Mock } from "vitest";
import { AdminAuditService, REDACTED, type AuditSnapshot } from "./admin-audit.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AdminActor } from "./admin.types";

const ACTOR: AdminActor = {
  customerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  role: "ADMIN",
  ipAddress: "203.0.113.7",
  userAgent: "AdminPanel/2.0",
  requestId: "req-abc",
};

interface CreateCall {
  readonly data: Record<string, unknown>;
}

/**
 * The audit-log `create`, typed on its ARGUMENT.
 *
 * `ReturnType<typeof vi.fn>` is `Mock<(...args: any[]) => any>`, so
 * `create.mock.calls[0]?.[0]` was an `any` — and this suite exists to assert
 * exactly what lands in that argument. Pinning the parameter means the row this
 * service writes is checked, not asserted.
 */
type AuditCreateFn = (args: CreateCall) => Promise<unknown>;

function buildService(): {
  service: AdminAuditService;
  create: Mock<AuditCreateFn>;
} {
  const create = vi.fn<AuditCreateFn>(async () => ({}));
  const prisma = { auditLogEntry: { create } } as unknown as PrismaService;
  return { service: new AdminAuditService(prisma), create };
}

describe("AdminAuditService — diff construction", () => {
  it("records only the keys that actually changed", () => {
    const { service } = buildService();

    const diff = service.buildDiff(
      { slug: "bpc-157", status: "DRAFT", priceGross: 4999 },
      { slug: "bpc-157", status: "ACTIVE", priceGross: 4999 },
    );

    // A full before/after pair per row would make the audit log a second copy of
    // the products table and bury the one field that moved.
    expect(Object.keys(diff)).toEqual(["status"]);
    expect(diff["status"]).toEqual({ before: "DRAFT", after: "ACTIVE" });
  });

  it("treats a create (before: null) as every key changing", () => {
    const { service } = buildService();
    const diff = service.buildDiff(null, { slug: "tb-500", priceGross: 8999 });

    expect(Object.keys(diff).sort()).toEqual(["priceGross", "slug"]);
    expect(diff["slug"]).toEqual({ before: null, after: "tb-500" });
  });

  it("compares structurally, so an unchanged nested object is not logged", () => {
    const { service } = buildService();

    const diff = service.buildDiff(
      { variants: [{ sku: "A", priceGross: 100 }] },
      { variants: [{ sku: "A", priceGross: 100 }] },
    );

    // Reference equality would report a change on every save, making the audit
    // log unreadable and hiding the real edits in the noise.
    expect(Object.keys(diff)).toEqual([]);
  });

  it("detects a nested change", () => {
    const { service } = buildService();

    const diff = service.buildDiff(
      { variants: [{ sku: "A", priceGross: 100 }] },
      { variants: [{ sku: "A", priceGross: 150 }] },
    );

    expect(Object.keys(diff)).toEqual(["variants"]);
  });
});

describe("AdminAuditService — PII redaction", () => {
  it("redacts a top-level PII value but keeps the fact of the change", () => {
    const { service } = buildService();

    const diff = service.buildDiff(
      { email: "old@example.com" },
      { email: "new@example.com" },
    );

    expect(diff["email"]).toEqual({ before: REDACTED, after: REDACTED });
  });

  it("redacts PII NESTED inside an object", () => {
    const { service } = buildService();

    const before: AuditSnapshot = {
      address: { shipLine1: "Calle Mayor 1", shipCity: "Madrid" },
    };
    const after: AuditSnapshot = {
      address: { shipLine1: "Gran Via 2", shipCity: "Madrid" },
    };

    const serialised = JSON.stringify(service.buildDiff(before, after));

    // A top-level-only redaction sweep is the usual way personal data escapes
    // into an append-only table that GDPR erasure cannot reach.
    expect(serialised).not.toContain("Calle Mayor 1");
    expect(serialised).not.toContain("Gran Via 2");
    // Non-PII siblings survive, or the diff would be useless.
    expect(serialised).toContain("Madrid");
  });

  it("redacts case-insensitively across naming conventions", () => {
    const { service } = buildService();

    const diff = service.buildDiff(
      { billFirstName: "Ana", shipPhone: "+34600000000", passwordHash: "argon2id$x" },
      { billFirstName: "Luis", shipPhone: "+34611111111", passwordHash: "argon2id$y" },
    );

    const serialised = JSON.stringify(diff);
    expect(serialised).not.toContain("Ana");
    expect(serialised).not.toContain("+34600000000");
    expect(serialised).not.toContain("argon2id$");
  });

  it("distinguishes 'was absent' from 'was redacted'", () => {
    const { service } = buildService();
    const diff = service.buildDiff(null, { email: "new@example.com" });

    // null before / redacted after says "an email was SET". Redacting the null
    // too would lose that distinction and make a create look like an edit.
    expect(diff["email"]).toEqual({ before: null, after: REDACTED });
  });
});

describe("AdminAuditService — writing", () => {
  it("writes the actor, action and entity, truncating to column widths", async () => {
    const { service, create } = buildService();

    await service.record({
      actor: ACTOR,
      action: "x".repeat(200),
      entityType: "y".repeat(200),
      entityId: "z".repeat(200),
      before: null,
      after: { slug: "bpc-157" },
    });

    expect(create).toHaveBeenCalledTimes(1);
    const call = create.mock.calls[0]?.[0];
    const data = call?.data ?? {};

    expect(data["actorId"]).toBe(ACTOR.customerId);
    expect(data["actorRole"]).toBe("ADMIN");
    expect(data["requestId"]).toBe("req-abc");
    // Truncated in the service, so an over-long action can never fail the INSERT
    // of the row that proves a change happened.
    expect(String(data["action"])).toHaveLength(80);
    expect(String(data["entityType"])).toHaveLength(64);
    expect(String(data["entityId"])).toHaveLength(64);
  });

  it("writes through the supplied transaction client, not the base client", async () => {
    const { service, create } = buildService();
    const txCreate = vi.fn(async () => ({}));

    await service.record(
      {
        actor: ACTOR,
        action: "product.update",
        entityType: "product",
        entityId: "prod-1",
        before: { status: "DRAFT" },
        after: { status: "ACTIVE" },
      },
      { auditLogEntry: { create: txCreate } } as unknown as PrismaService,
    );

    // Spec §13: the audit row is written in the SAME transaction as the change
    // it describes. Using the base client here would let a rolled-back change
    // leave a phantom audit entry claiming it succeeded.
    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("exposes no mutation method — the log is append-only", () => {
    const { service } = buildService();

    // Enforced again at the DB layer (the runtime role has INSERT + SELECT only
    // on audit_log), but a service with an update method invites someone to
    // grant the permission that would make it work.
    const methods = Object.getOwnPropertyNames(AdminAuditService.prototype);
    expect(methods).not.toContain("update");
    expect(methods).not.toContain("delete");
    expect(service).not.toHaveProperty("deleteEntry");
  });
});
