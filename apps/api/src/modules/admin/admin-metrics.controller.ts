import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import type { Paginated } from "@akai/contracts";
import { AdminGuard } from "./admin.guard";
import { AdminRoles } from "./admin.decorators";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  auditLogQuerySchema,
  listLimitQuerySchema,
  metricsWindowQuerySchema,
  topProductsQuerySchema,
  type AuditLogQuery,
} from "./admin.dto";
import {
  AdminMetricsService,
  type DailyRevenuePoint,
  type EmailDeliverySummary,
  type LowStockVariant,
  type RecentOrder,
  type RepeatCustomerRate,
  type ReturnsSummary,
  type RevenueSummary,
  type StatusCount,
  type TopProduct,
} from "./admin-metrics.service";
import { AdminAuditService, type AuditLogListItem } from "./admin-audit.service";

interface DashboardOverview {
  readonly revenue: RevenueSummary;
  readonly ordersByStatus: readonly StatusCount[];
}

/**
 * Read-only dashboard aggregates.
 *
 * STAFF as well as ADMIN: these are reporting endpoints, and requiring full
 * admin for "how many orders shipped this week" pushes people towards sharing
 * the admin account, which is a worse outcome than a slightly wider read scope.
 * Every mutating endpoint stays ADMIN-only (see AdminProductsController).
 */
@Controller("admin/metrics")
@UseGuards(AdminGuard)
@AdminRoles("STAFF", "ADMIN")
export class AdminMetricsController {
  constructor(private readonly metrics: AdminMetricsService) {}

  /**
   * The dashboard's landing payload.
   *
   * Revenue and status counts are returned together in ONE round trip because
   * they are always rendered together; two endpoints would let a client paint a
   * revenue figure and an order count computed over different windows, which
   * reads as a data bug to whoever is looking at it.
   */
  @Get("overview")
  async overview(
    @Query(new ZodValidationPipe(metricsWindowQuerySchema))
    query: { from: Date; to: Date; currency: string },
  ): Promise<DashboardOverview> {
    const [revenue, ordersByStatus] = await Promise.all([
      this.metrics.revenue(query),
      this.metrics.orderCountsByStatus(query),
    ]);

    return { revenue, ordersByStatus };
  }

  @Get("top-products")
  topProducts(
    @Query(new ZodValidationPipe(topProductsQuerySchema))
    query: { from: Date; to: Date; currency: string; limit: number },
  ): Promise<readonly TopProduct[]> {
    return this.metrics.topProducts(query, query.limit);
  }

  @Get("low-stock")
  lowStock(
    @Query(new ZodValidationPipe(listLimitQuerySchema))
    query: { limit: number },
  ): Promise<readonly LowStockVariant[]> {
    return this.metrics.lowStock(query.limit);
  }

  @Get("recent-orders")
  recentOrders(
    @Query(new ZodValidationPipe(listLimitQuerySchema))
    query: { limit: number },
  ): Promise<readonly RecentOrder[]> {
    return this.metrics.recentOrders(query.limit);
  }

  @Get("repeat-rate")
  repeatRate(
    @Query(new ZodValidationPipe(metricsWindowQuerySchema))
    query: { from: Date; to: Date; currency: string },
  ): Promise<RepeatCustomerRate> {
    return this.metrics.repeatCustomerRate(query);
  }

  @Get("returns")
  returns(
    @Query(new ZodValidationPipe(metricsWindowQuerySchema))
    query: { from: Date; to: Date; currency: string },
  ): Promise<ReturnsSummary> {
    return this.metrics.returnsSummary(query);
  }

  @Get("emails")
  emails(
    @Query(new ZodValidationPipe(metricsWindowQuerySchema))
    query: { from: Date; to: Date; currency: string },
  ): Promise<EmailDeliverySummary> {
    return this.metrics.emailDeliverySummary(query);
  }

  @Get("revenue-series")
  revenueSeries(
    @Query(new ZodValidationPipe(metricsWindowQuerySchema))
    query: { from: Date; to: Date; currency: string },
  ): Promise<readonly DailyRevenuePoint[]> {
    return this.metrics.dailyRevenue(query);
  }
}

/**
 * The audit trail.
 *
 * READ-ONLY by construction: there is deliberately no POST, PATCH or DELETE
 * route on this controller, and AdminAuditService exposes no mutation method.
 * Even if one were added, the runtime DB role holds INSERT + SELECT only on
 * `audit_log` (spec §4), so the guarantee is enforced at two independent layers.
 */
@Controller("admin/audit")
@UseGuards(AdminGuard)
@AdminRoles("STAFF", "ADMIN")
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(auditLogQuerySchema)) query: AuditLogQuery,
  ): Promise<Paginated<AuditLogListItem>> {
    return this.audit.list(query);
  }
}
