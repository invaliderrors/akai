import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { type ServerEnv } from "@akai/config";
import { PrismaClient } from "@akai/db";
import { SERVER_CONFIG } from "../config/config.module";

/**
 * The Prisma client, as an injectable service.
 *
 * Extending PrismaClient rather than wrapping it keeps the full typed query API
 * available (`prisma.order.findMany(...)`) with no re-export layer to maintain,
 * while still giving Nest a class to manage the connection lifecycle on.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(SERVER_CONFIG) config: ServerEnv) {
    const verbose = config.LOG_LEVEL === "debug" || config.LOG_LEVEL === "trace";

    super({
      // The URL comes from the VALIDATED config, never from process.env
      // directly. Letting Prisma read the environment itself would allow an
      // unvalidated connection string through and defeat the fail-fast rule.
      datasources: { db: { url: config.DATABASE_URL } },
      log: verbose ? ["query", "warn", "error"] : ["warn", "error"],
    });
  }

  async onModuleInit(): Promise<void> {
    // Connect eagerly so a bad DATABASE_URL surfaces at boot rather than on the
    // first request that happens to touch the database.
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    // Part of graceful shutdown: a deploy must not truncate an in-flight
    // payment handler mid-transaction.
    await this.$disconnect();
  }

  /** Cheap connectivity probe for the readiness endpoint. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
