import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminAuditService } from "./admin-audit.service";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { AdminMetricsService } from "./admin-metrics.service";
import { AdminProductsService } from "./admin-products.service";
import { AdminAuditController, AdminMetricsController } from "./admin-metrics.controller";
import { AdminProductsController } from "./admin-products.controller";
import { AdminGuard } from "./admin.guard";
import { PrismaAdminSessionReader } from "./prisma-admin-session.reader";
import { ADMIN_SESSION_READER, CATALOG_ADMIN_PORT } from "./admin.types";
import { UnboundCatalogAdminPort } from "./unbound-catalog.port";

/**
 * AdminModule — the thin composition layer for the whole /admin/* surface
 * (spec §13). Every privileged controller is mounted here and nowhere else, so
 * "what can an admin do" is answerable by reading one file.
 *
 * WHAT THIS MODULE DOES NOT DO: product CRUD, order state transitions, refunds.
 * Those live in their owning domain modules. This module composes, guards and
 * audits them. The moment domain rules start appearing here, the admin API and
 * the storefront API have diverged and one of them is wrong.
 *
 * INTEGRATION NOTE (see followUps): two providers below are stand-ins that the
 * integration pass rebinds to their real owners.
 *  - ADMIN_SESSION_READER → AuthModule's session service.
 *  - CATALOG_ADMIN_PORT   → CatalogModule's admin-facing service.
 * Both are declared as ports precisely so that rebinding is a one-line change
 * in this file and touches nothing else.
 */
@Module({
  // IdempotencyModule rather than a local provider: the reservation table is
  // shared with checkout, and two module-scoped instances of the same service
  // would be harmless today and misleading the first time one of them grows
  // state.
  imports: [PrismaModule, IdempotencyModule],
  controllers: [AdminMetricsController, AdminAuditController, AdminProductsController],
  providers: [
    AdminGuard,
    AdminAuditService,
    AdminMetricsService,
    AdminProductsService,
    { provide: ADMIN_SESSION_READER, useClass: PrismaAdminSessionReader },
    { provide: CATALOG_ADMIN_PORT, useClass: UnboundCatalogAdminPort },
  ],
  // Exported so other modules can audit their own mutations through the same
  // service rather than writing audit rows by hand — one writer means one
  // redaction policy.
  exports: [AdminAuditService],
})
export class AdminModule {}
