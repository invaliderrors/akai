import { PrismaClient } from "@prisma/client";

export { Prisma, PrismaClient } from "@prisma/client";

/**
 * Re-export the generated enums and model types so the rest of the workspace
 * imports them from `@akai/db` rather than reaching into `@prisma/client`
 * directly. That indirection is what makes the ORM replaceable, and it keeps
 * `@prisma/client` off every other project's dependency surface.
 */
export type {
  Address,
  AuditLogEntry,
  // AuthToken and RecoveryCode were missing from this list, so the auth module
  // had to reconstruct AuthToken via `Prisma.AuthTokenGetPayload<...>` — a
  // workaround that produces the right type today but silently diverges the
  // moment the model gains a field. Exported here so there is one name for it.
  AuthToken,
  Cart,
  CartItem,
  Category,
  ConsentRecord,
  Customer,
  Discount,
  DiscountRedemption,
  Dispute,
  EmailEvent,
  EmailSuppression,
  IdempotencyRecord,
  InventoryItem,
  InventoryLedgerEntry,
  MediaAsset,
  Order,
  OrderEvent,
  OrderItem,
  OutboxMessage,
  Payment,
  PriceHistory,
  Product,
  ProviderEvent,
  ProductVariant,
  RecoveryCode,
  Refund,
  RefreshToken,
  ReturnRequest,
  Session,
  Shipment,
  ShipmentItem,
  ShippingRate,
  ShippingZone,
  StockReservation,
  TaxRate,
} from "@prisma/client";

export {
  AddressType,
  DiscountType,
  EmailStatus,
  InventoryMovement,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  ProductStatus,
  RefundReason,
  RefundStatus,
  ReturnStatus,
  Role,
  ShipmentStatus,
  TaxClass,
} from "@prisma/client";

export interface PrismaClientOptions {
  readonly databaseUrl: string;
  readonly logQueries?: boolean;
}

/**
 * Build a PrismaClient.
 *
 * Takes the URL explicitly rather than letting Prisma read `process.env`, so the
 * validated config from @akai/config is the only path a connection string can
 * take into the process. That is what makes the fail-fast guarantee real: if
 * Prisma read the env itself, an unvalidated URL could still get through.
 */
export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: options.databaseUrl } },
    log: options.logQueries === true ? ["query", "warn", "error"] : ["warn", "error"],
    // Interactive-transaction budgets, raised from Prisma's defaults (2 s maxWait,
    // 5 s timeout). The Wompi settlement transaction is DELIBERATELY serialised on
    // a `SELECT … FOR UPDATE` order-row lock (see PaymentsWriter.findOrderByPayment
    // Reference): when the webhook and the return-page confirmation race for one
    // order, the loser BLOCKS on that lock, and the block time counts against
    // maxWait/timeout. A large order (per-reservation commit issues 2+ queries)
    // under that contention can exceed 5 s, raising P2028 — which is not a unique
    // violation, so it escapes `runOnceForEvent`, rolls the transaction back, and
    // surfaces as a 500 (a non-200 makes Wompi retry). Widening the
    // budget removes that failure mode without weakening the lock, which is what
    // actually provides the serialisation.
    transactionOptions: { maxWait: 10_000, timeout: 30_000 },
  });
}
