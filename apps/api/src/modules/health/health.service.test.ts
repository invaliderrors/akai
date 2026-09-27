import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { healthResponseSchema } from "@akai/contracts";
import { HealthService } from "./health.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Also serves as the standing proof that Nest DI + Vitest + decorator metadata
 * work for a REAL service with a real injected dependency — not just the
 * two-provider probe in nest-di.test.ts.
 */
async function buildService(ping: () => Promise<void>): Promise<HealthService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      HealthService,
      { provide: PrismaService, useValue: { ping } },
    ],
  }).compile();

  return moduleRef.get(HealthService);
}

describe("HealthService", () => {
  it("reports liveness without touching any dependency", async () => {
    const ping = vi.fn(async () => {
      throw new Error("database is down");
    });
    const service = await buildService(ping);

    const result = service.liveness();

    expect(result.status).toBe("ok");
    // The critical assertion: a database blip must NOT make the orchestrator
    // kill every pod, which is what happens if liveness probes dependencies.
    expect(ping).not.toHaveBeenCalled();
    expect(healthResponseSchema.safeParse(result).success).toBe(true);
  });

  it("reports ready when the database answers", async () => {
    const service = await buildService(async () => undefined);
    const result = await service.readiness();

    expect(result.status).toBe("ok");
    expect(result.checks["database"]?.status).toBe("up");
    expect(result.checks["database"]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports error — without throwing — when the database is down", async () => {
    const service = await buildService(async () => {
      throw new Error("connect ECONNREFUSED postgresql://user:pw@10.0.0.5:5432/db");
    });

    const result = await service.readiness();

    expect(result.status).toBe("error");
    expect(result.checks["database"]?.status).toBe("down");
  });

  it("does NOT leak the connection string through the probe response", async () => {
    const service = await buildService(async () => {
      throw new Error("connect ECONNREFUSED postgresql://user:hunter2@10.0.0.5:5432/db");
    });

    const serialised = JSON.stringify(await service.readiness());
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain("10.0.0.5");
  });

  it("emits a schema-valid response in every branch", async () => {
    const up = await buildService(async () => undefined);
    const down = await buildService(async () => {
      throw new Error("nope");
    });

    expect(healthResponseSchema.safeParse(await up.readiness()).success).toBe(true);
    expect(healthResponseSchema.safeParse(await down.readiness()).success).toBe(true);
  });
});
