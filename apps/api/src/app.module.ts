import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { RequestContextMiddleware } from "./common/middleware/request-context.middleware";
import { JwtAuthGuard } from "./modules/auth/guards/jwt-auth.guard";
import { RolesGuard } from "./modules/auth/guards/roles.guard";

// --- Infrastructure (implemented) -------------------------------------------
import { ConfigModule } from "./modules/config/config.module";
import { LoggerModule } from "./modules/observability/logger.module";
import { PrismaModule } from "./modules/prisma/prisma.module";
import { HealthModule } from "./modules/health/health.module";

// --- Domain (placeholders — filled one module per commit, spec R6) -----------
import { AdminModule } from "./modules/admin/admin.module";
import { AffiliatesModule } from "./modules/affiliates/affiliates.module";
import { AuditModule } from "./modules/audit/audit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { BlogModule } from "./modules/blog/blog.module";
import { CartModule } from "./modules/cart/cart.module";
import { CatalogModule } from "./modules/catalog/catalog.module";
import { CategoriesModule } from "./modules/categories/categories.module";
import { CheckoutModule } from "./modules/checkout/checkout.module";
import { ContactModule } from "./modules/contact/contact.module";
import { DiscountsModule } from "./modules/discounts/discounts.module";
import { DisputesModule } from "./modules/disputes/disputes.module";
import { EmailModule } from "./modules/email/email.module";
import { GdprModule } from "./modules/gdpr/gdpr.module";
import { IdempotencyModule } from "./modules/idempotency/idempotency.module";
import { InventoryModule } from "./modules/inventory/inventory.module";
import { InvoicesModule } from "./modules/invoices/invoices.module";
import { MediaModule } from "./modules/media/media.module";
import { MetricsModule } from "./modules/metrics/metrics.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { OrdersModule } from "./modules/orders/orders.module";
import { OutboxModule } from "./modules/outbox/outbox.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { PricingModule } from "./modules/pricing/pricing.module";
import { QueueModule } from "./modules/queue/queue.module";
import { ReturnsModule } from "./modules/returns/returns.module";
import { RevalidationModule } from "./modules/revalidation/revalidation.module";
import { ShippingModule } from "./modules/shipping/shipping.module";
import { AdminShippingModule } from "./modules/shipping/admin/admin-shipping.module";
import { SiteSettingsModule } from "./modules/site-settings/site-settings.module";
import { TaxModule } from "./modules/tax/tax.module";
import { ThrottlerModule } from "./modules/throttler/throttler.module";
import { TranslationModule } from "./modules/translation/translation.module";
import { UsersModule } from "./modules/users/users.module";

/**
 * Root composition root for the HTTP API.
 *
 * Every domain module the architecture lists is imported here from day one,
 * even while empty. Two reasons that is worth the noise: the intended shape of
 * the system is reviewable in one file, and later agents extend a module that
 * already exists rather than inventing a parallel structure for the same
 * concern.
 *
 * ConfigModule, LoggerModule and PrismaModule are @Global — they are read
 * everywhere and depend on nothing, which is the one case where global scope
 * beats explicit imports.
 */
@Module({
  imports: [
    // Infrastructure first: everything below depends on config and logging.
    ConfigModule,
    LoggerModule,
    PrismaModule,
    HealthModule,

    // Cross-cutting services.
    QueueModule,
    OutboxModule,
    IdempotencyModule,
    AuditModule,
    ThrottlerModule,
    EmailModule,
    NotificationsModule,

    // Identity. CustomersModule and AddressesModule were empty placeholders
    // covering the same aggregate as UsersModule; they are deleted rather than
    // left as two plausible-looking homes for the next person to add a
    // customer feature to.
    AuthModule,

    // Catalog.
    CatalogModule,
    CategoriesModule,
    MediaModule,
    PricingModule,
    InventoryModule,

    // Commerce.
    CartModule,
    DiscountsModule,
    TaxModule,
    ShippingModule,
    // Staff-editable zones and rates — writes the rows ShippingModule reads
    // live.
    AdminShippingModule,
    CheckoutModule,
    OrdersModule,
    PaymentsModule,
    InvoicesModule,

    // Post-purchase.
    ReturnsModule,
    DisputesModule,

    // Platform.
    GdprModule,
    ContactModule,
    // The affiliate application form and its admin screen — same abuse
    // shape as ContactModule immediately above (anonymous POST, outbound
    // email), and its admin surface mounts its own /admin/* controller for
    // the same reason TranslationModule/SiteSettingsModule below do.
    AffiliatesModule,
    MetricsModule,
    RevalidationModule,
    // The DeepL vendor layer behind the admin product form. Mounts its own
    // /admin/* controller rather than joining AdminModule, because it needs
    // that module's guard and nothing else from its graph — see the note in
    // translation.module.ts.
    TranslationModule,
    // Maintenance mode, and — one day — whatever else joins it on the same
    // singleton row. Mounts its own /admin/* controller for the identical
    // reason TranslationModule does: it needs RolesGuard and nothing else
    // from AdminModule's graph.
    SiteSettingsModule,
    // The blog (spec 2026-09-24 §8): public list/detail plus its own
    // /admin/blog/* controller, same self-mounting reason as the two above.
    BlogModule,

    // Admin composition layer LAST: it mounts every /admin/* controller behind
    // RolesGuard, so the privileged surface is auditable in one place.
    AdminModule,

    // UsersModule owns the Customer aggregate: profile, address book, GDPR
    // export/erasure and the admin customer surface. It is imported after
    // AuthModule because its controllers carry @Roles from there.
    UsersModule,
  ],
  providers: [
    /**
     * THE deny-by-default authorisation pipeline (spec §8).
     *
     * ORDER IS LOAD-BEARING. Nest runs APP_GUARD providers in declaration
     * order, and RolesGuard reads the principal that JwtAuthGuard attaches. If
     * these were swapped, RolesGuard would find no principal on every request
     * and throw 401 even for a correctly authenticated admin — the API would
     * fail closed, which is safe, but uniformly broken.
     *
     * Registering them GLOBALLY rather than per controller is the entire point.
     * Until this existed, every `@Public()` and `@Roles()` decorator in the tree
     * was inert metadata: nothing read it, so the API was open by default and
     * the modules that had written their own local guards were the only ones
     * protected at all. A per-controller guard protects the controllers someone
     * remembered; a global one makes forgetting fail loudly (a 401 in
     * development) instead of silently (an exposed endpoint in production).
     */
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route and registered before any guard or interceptor, so
    // even the earliest failures carry a request id into the error envelope.
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}
