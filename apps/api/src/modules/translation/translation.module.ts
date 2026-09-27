import { Module } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";
import type { TranslationPort } from "@akai/contracts";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminGuard } from "../admin/admin.guard";
import { PrismaAdminSessionReader } from "../admin/prisma-admin-session.reader";
import { ADMIN_SESSION_READER } from "../admin/admin.types";
import { DeeplTranslationGateway, type TranslationLogger } from "./deepl.gateway";
import { UnconfiguredTranslationGateway } from "./unconfigured-translation.gateway";
import { TRANSLATION_GATEWAY } from "./translation.port";
import { TranslationController } from "./translation.controller";
import { TranslationService } from "./translation.service";

/** Just the key, so the factory is testable without building a whole ServerEnv. */
export interface TranslationGatewayConfig {
  readonly DEEPL_API_KEY?: string | undefined;
}

/**
 * Choose the gateway from VALIDATED config.
 *
 * AN EMPTY STRING IS "UNSET". `.env.example` ships `DEEPL_API_KEY=` (an active
 * line, so the operator sees the variable exists), and `z.string().optional()`
 * accepts `""` — so without this check a default environment would authenticate
 * against DeepL with an empty credential and every translation would come back
 * as a 403 INVALID_KEY, which reads like a revoked key rather than like a
 * feature nobody turned on. ContactModule treats TURNSTILE_SECRET_KEY the same
 * way, for the same reason.
 */
export function createTranslationGateway(
  config: TranslationGatewayConfig,
  logger: TranslationLogger,
): TranslationPort {
  const apiKey = config.DEEPL_API_KEY?.trim() ?? "";

  if (apiKey === "") {
    return new UnconfiguredTranslationGateway();
  }

  return new DeeplTranslationGateway({ apiKey }, logger);
}

/**
 * TranslationModule — the DeepL vendor layer behind the admin product form.
 *
 * WHY IT BINDS ADMIN GUARD AND SESSION READER ITSELF rather than importing
 * AdminModule: it needs two providers from a module that also carries bulk
 * catalogue import/export, the metrics service, the audit service and the
 * idempotency store. Importing all of that to borrow a guard would couple a
 * translation call to the entire privileged graph — and AdminModule exports
 * neither token, so it would also mean widening that module's public surface
 * for a consumer with nothing to do with admin composition. ContactModule binds
 * its captcha verifier on exactly this reasoning. The IMPLEMENTATIONS are
 * imported, so there is still one AdminGuard and one session reader in the
 * codebase; only the binding is repeated.
 */
@Module({
  imports: [PrismaModule],
  controllers: [TranslationController],
  providers: [
    TranslationService,
    AdminGuard,
    { provide: ADMIN_SESSION_READER, useClass: PrismaAdminSessionReader },
    {
      provide: TRANSLATION_GATEWAY,
      inject: [SERVER_CONFIG, LOGGER],
      useFactory: (config: ServerEnv, logger: Logger): TranslationPort =>
        createTranslationGateway(config, logger),
    },
  ],
  exports: [TranslationService],
})
export class TranslationModule {}
