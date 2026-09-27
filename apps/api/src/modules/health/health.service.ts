import { Injectable } from "@nestjs/common";
import { healthResponseSchema, type HealthResponse } from "@akai/contracts";
import { PrismaService } from "../prisma/prisma.service";

/** Set at build time; falls back so a local run still reports something useful. */
const SERVICE_VERSION = process.env["APP_VERSION"] ?? "0.1.0-dev";

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  liveness(): HealthResponse {
    return healthResponseSchema.parse({
      status: "ok",
      version: SERVICE_VERSION,
      uptimeSeconds: this.uptimeSeconds(),
      checks: {},
    });
  }

  async readiness(): Promise<HealthResponse> {
    const database = await this.checkDatabase();

    return healthResponseSchema.parse({
      status: database.status === "up" ? "ok" : "error",
      version: SERVICE_VERSION,
      uptimeSeconds: this.uptimeSeconds(),
      checks: { database },
    });
  }

  private uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /**
   * Never throws. A readiness endpoint that 500s tells the orchestrator far less
   * than one that reports WHICH dependency is down — and the failure message is
   * truncated because a driver error can carry the connection string.
   */
  private async checkDatabase(): Promise<{
    status: "up" | "down";
    latencyMs?: number;
    error?: string;
  }> {
    const startedAt = Date.now();
    try {
      await this.prisma.ping();
      return { status: "up", latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: "down",
        error: error instanceof Error ? error.name : "Unknown error",
      };
    }
  }
}
