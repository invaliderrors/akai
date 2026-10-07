import "reflect-metadata";
import { loadServerConfig, resetServerConfigCache, type ServerEnv } from "@akai/config";
import { toMinor, type OrderStatus } from "@akai/contracts";
import { createLogger } from "@akai/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RESERVATION_TTL_SECONDS } from "../checkout/checkout.service";
import { startCheckoutSchema } from "./dto/payments.dto";
import { settleOrderPaid } from "./order-settlement";
import { TransitionTableOrderState } from "./order-state.port";
import {
  CheckoutTotalMismatchError,
  OrderNotFoundError,
  OrderNotPayableError,
  UnsupportedCurrencyError,
} from "./payments.errors";
import { PaymentsService, STALLED_TRANSACTION_AGE_MS } from "./payments.service";
import {
  FakePaymentsRepository,
  checkoutDetails,
  orderLine,
  orderSnapshot,
  paymentSnapshot,
} from "./testing/payments.fakes";
import { FakeWompiGateway, wompiTransaction } from "./testing/wompi.fakes";
import { CHECKOUT_EXPIRY_MS, wompiIntegritySignature } from "./wompi/wompi-checkout";
import { WompiSettlementService } from "./wompi-settlement.service";
import { PaymentProviderUnavailableError } from "./payments.errors";

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  DIRECT_DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "pub_test_unit",
  WOMPI_PRIVATE_KEY: "prv_test_unit",
  WOMPI_INTEGRITY_SECRET: "test_integrity_unit",
  WOMPI_EVENTS_SECRET: "test_events_unit",
  EMAIL_TRANSPORT: "smtp",
  SMTP_URL: "smtp://localhost:1025",
  EMAIL_FROM: "no-reply@example.com",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "akai-media",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  STOREFRONT_URL: "http://localhost:3000",
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
};

const NOW = new Date("2026-10-06T12:00:00.000Z");

let savedEnv: NodeJS.ProcessEnv;
let repository: FakePaymentsRepository;
let wompi: FakeWompiGateway;
let service: PaymentsService;
let config: ServerEnv;

function buildService(): PaymentsService {
  const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });
  const orderState = new TransitionTableOrderState();
  return new PaymentsService(
    repository,
    wompi,
    new WompiSettlementService(repository, orderState, logger),
    orderState,
    config,
    logger,
  );
}

function useEnv(overrides: NodeJS.ProcessEnv = {}): void {
  process.env = { ...TEST_ENV, ...overrides };
  resetServerConfigCache();
  config = loadServerConfig();
  service = buildService();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  savedEnv = process.env;
  repository = new FakePaymentsRepository();
  wompi = new FakeWompiGateway();
  useEnv();
});

afterEach(() => {
  vi.useRealTimers();
  process.env = savedEnv;
  resetServerConfigCache();
});

async function checkoutParams(orderId: string): Promise<URLSearchParams> {
  const { checkoutUrl } = await service.startCheckout(orderId);
  return new URL(checkoutUrl).searchParams;
}

// ---------------------------------------------------------------------------
// The rule: the client never supplies an amount.
// ---------------------------------------------------------------------------

describe("checkout request contract", () => {
  it("has no field through which a caller could propose an amount", () => {
    expect(Object.keys(startCheckoutSchema.shape)).toEqual(["orderId"]);
  });

  it("refuses a smuggled amount rather than stripping it", () => {
    const result = startCheckoutSchema.safeParse({
      orderId: "11111111-1111-4111-8111-111111111111",
      amount: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("PaymentsService.startCheckout", () => {
  it("builds a Wompi Web Checkout URL for OUR grand total, in centavos", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    const { orderNumber, checkoutUrl } = await service.startCheckout(order.id);
    const params = new URL(checkoutUrl).searchParams;

    expect(orderNumber).toBe("AK-2026-000123");
    expect(checkoutUrl.startsWith("https://checkout.wompi.co/p/?")).toBe(true);
    expect(params.get("amount-in-cents")).toBe("8900000");
    expect(params.get("currency")).toBe("COP");
    expect(params.get("public-key")).toBe("pub_test_unit");
  });

  it("signs the reference, amount, currency and expiration with the integrity secret", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    const params = await checkoutParams(order.id);

    expect(params.get("signature:integrity")).toBe(
      wompiIntegritySignature({
        reference: "AK-2026-000123-1",
        amountInCents: toMinor(8_900_000),
        currency: "COP",
        expirationTime: params.get("expiration-time"),
        integritySecret: "test_integrity_unit",
      }),
    );
  });

  it("expires the link 25 minutes out — inside the stock reservation's TTL", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    const params = await checkoutParams(order.id);

    expect(params.get("expiration-time")).toBe(
      new Date(NOW.getTime() + CHECKOUT_EXPIRY_MS).toISOString(),
    );
    expect(CHECKOUT_EXPIRY_MS).toBeLessThan(RESERVATION_TTL_SECONDS * 1000);
  });

  it("mints a NEW reference per attempt and persists it before redirecting", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    const first = await checkoutParams(order.id);
    const second = await checkoutParams(order.id);

    expect(first.get("reference")).toBe("AK-2026-000123-1");
    expect(second.get("reference")).toBe("AK-2026-000123-2");
    expect(repository.payments.map((row) => row.providerReference)).toEqual([
      "AK-2026-000123-1",
      "AK-2026-000123-2",
    ]);
    expect(repository.payments.every((row) => row.status === "REQUIRES_PAYMENT_METHOD")).toBe(
      true,
    );
    // Counted under the order row lock, so two starts cannot mint the same one.
    expect(repository.locks).toEqual([order.id, order.id]);
  });

  it("moves the order to AWAITING_PAYMENT in the same transaction as the attempt", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);

    expect(repository.order(order.id).status).toBe("AWAITING_PAYMENT");
    expect(repository.orderEvents.map((event) => event.type)).toEqual([
      "checkout.session.created",
    ]);
  });

  it("writes nothing when the transaction fails", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);
    repository.failNextTransaction = true;

    await expect(service.startCheckout(order.id)).rejects.toThrow("Simulated commit failure");

    expect(repository.payments).toHaveLength(0);
    expect(repository.order(order.id).status).toBe("PENDING");
  });

  it("declares the IVA contained in the total", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    expect((await checkoutParams(order.id)).get("tax-in-cents:vat")).toBe("1421008");
  });

  it("pre-fills the payer and shipping address from the order snapshot", async () => {
    const order = orderSnapshot();
    repository.seedOrder(
      order,
      [orderLine()],
      checkoutDetails({ documentType: "NIT", documentNumber: "900123456-7" }),
    );

    const params = await checkoutParams(order.id);

    expect(params.get("customer-data:email")).toBe("customer@example.com");
    expect(params.get("customer-data:full-name")).toBe("Ana García");
    expect(params.get("customer-data:phone-number")).toBe("3001234567");
    expect(params.get("customer-data:phone-number-prefix")).toBe("+57");
    expect(params.get("customer-data:legal-id")).toBe("900123456-7");
    expect(params.get("customer-data:legal-id-type")).toBe("NIT");
    expect(params.get("shipping-address:address-line-1")).toBe("Calle 10 # 43-21");
    expect(params.get("shipping-address:region")).toBe("Antioquia");
    expect(params.get("shipping-address:country")).toBe("CO");
  });

  it("sends the browser to a PROCESSING screen at its bare path", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);
    expect((await checkoutParams(order.id)).get("redirect-url")).toBe(
      "http://localhost:3000/checkout/processing?order=AK-2026-000123",
    );
  });

  it("collapses a multi-line order into one correct figure", async () => {
    const order = orderSnapshot({ grandTotal: toMinor(13_000_000), taxTotal: toMinor(2_075_630) });
    repository.seedOrder(order, [
      orderLine({ lineTotalGross: toMinor(8_900_000), taxAmount: toMinor(1_421_008) }),
      orderLine({
        id: "22222222-2222-4222-8222-222222222223",
        lineTotalGross: toMinor(4_100_000),
        taxAmount: toMinor(654_622),
      }),
    ]);

    expect((await checkoutParams(order.id)).get("amount-in-cents")).toBe("13000000");
  });

  it("REFUSES to sign a total its own lines disagree with, touching nothing", async () => {
    const order = orderSnapshot({ grandTotal: toMinor(8_900_000) });
    repository.seedOrder(order, [
      orderLine({ lineTotalGross: toMinor(5_000_000), taxAmount: toMinor(798_319) }),
    ]);

    await expect(service.startCheckout(order.id)).rejects.toThrow(CheckoutTotalMismatchError);
    expect(repository.payments).toHaveLength(0);
    expect(repository.order(order.id).status).toBe("PENDING");
  });

  it("counts shipping, and the tax on shipping, toward the consistency check", async () => {
    // Lines are stored gross, shipping NET with its tax inside taxTotal:
    // 8_900_000 gross line (1_421_008 tax) + 1_260_504 net shipping + 239_496
    // shipping tax = 10_400_000.
    const order = orderSnapshot({
      grandTotal: toMinor(10_400_000),
      shippingTotal: toMinor(1_260_504),
      taxTotal: toMinor(1_660_504),
    });
    repository.seedOrder(order, [orderLine()]);

    expect((await checkoutParams(order.id)).get("amount-in-cents")).toBe("10400000");
  });

  it("checks out a discounted order — the discount is simply a smaller total", async () => {
    const order = orderSnapshot({
      grandTotal: toMinor(8_010_000),
      discountTotal: toMinor(890_000),
      taxTotal: toMinor(1_278_908),
    });
    repository.seedOrder(order, [
      orderLine({ lineTotalGross: toMinor(8_010_000), taxAmount: toMinor(1_278_908) }),
    ]);

    expect((await checkoutParams(order.id)).get("amount-in-cents")).toBe("8010000");
  });

  it("refuses a non-COP order — Wompi charges COP only", async () => {
    const order = orderSnapshot({ currency: "USD" });
    repository.seedOrder(order, [orderLine()]);

    await expect(service.startCheckout(order.id)).rejects.toThrow(UnsupportedCurrencyError);
  });

  it.each<OrderStatus>(["PAID", "PAYMENT_MISMATCH", "FAILED", "CANCELLED"])(
    "rejects a checkout for an order that is %s",
    async (status) => {
      const order = orderSnapshot({ status });
      repository.seedOrder(order, [orderLine()]);

      await expect(service.startCheckout(order.id)).rejects.toThrow(OrderNotPayableError);
      expect(repository.payments).toHaveLength(0);
    },
  );

  it("404s on an unknown order", async () => {
    await expect(service.startCheckout("99999999-9999-4999-8999-999999999999")).rejects.toThrow(
      OrderNotFoundError,
    );
  });
});

describe("PAYMENTS_ENABLED=false (demo mode)", () => {
  it("settles locally, returns the processing URL and writes no payment row", async () => {
    useEnv({ PAYMENTS_ENABLED: "false" });
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    const { checkoutUrl } = await service.startCheckout(order.id);

    expect(checkoutUrl).toBe("http://localhost:3000/checkout/processing?order=AK-2026-000123");
    expect(repository.order(order.id).status).toBe("PAID");
    expect(repository.payments).toHaveLength(0);
    expect(repository.invoiceNumberFor(order.id)).toMatch(/^INV-/);
  });

  it("does NOT burn a second invoice number when the settlement runs again", async () => {
    useEnv({ PAYMENTS_ENABLED: "false" });
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);
    const allocated = repository.invoiceNumberFor(order.id);

    await repository.runInTransaction((tx) =>
      settleOrderPaid(tx, repository.order(order.id), {
        occurredAt: new Date("2026-09-10T09:00:00.000Z"),
        timelineMessage: "duplicate delivery",
      }),
    );

    expect(repository.invoiceNumberFor(order.id)).toBe(allocated);
    expect(repository.invoiceNumbersIssued).toHaveLength(1);
  });

  it("boots and checks out with no Wompi keys at all", async () => {
    useEnv({
      PAYMENTS_ENABLED: "false",
      WOMPI_PUBLIC_KEY: "",
      WOMPI_PRIVATE_KEY: "",
      WOMPI_INTEGRITY_SECRET: "",
      WOMPI_EVENTS_SECRET: "",
    });
    expect(config.wompi).toBeNull();

    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);
    await expect(service.startCheckout(order.id)).resolves.toBeDefined();
  });
});

describe("PaymentsService.getOrderPaymentStatus", () => {
  async function statusFor(status: OrderStatus) {
    repository.seedOrder(orderSnapshot({ status }));
    return service.getOrderPaymentStatus("AK-2026-000123");
  }

  it("reports an awaiting order as neither paid nor finished", async () => {
    expect(await statusFor("AWAITING_PAYMENT")).toMatchObject({ isPaid: false, isTerminal: false });
  });

  it("reports a paid order as paid", async () => {
    expect(await statusFor("PAID")).toMatchObject({ isPaid: true, isTerminal: false });
  });

  it("NEVER reports PAYMENT_MISMATCH as paid, and stops the poll on it", async () => {
    expect(await statusFor("PAYMENT_MISMATCH")).toMatchObject({ isPaid: false, isTerminal: true });
  });

  it("reports failure as finished and unpaid", async () => {
    expect(await statusFor("FAILED")).toMatchObject({ isPaid: false, isTerminal: true });
  });

  it("404s on an unknown order number", async () => {
    await expect(service.getOrderPaymentStatus("AK-2026-999999")).rejects.toThrow(
      OrderNotFoundError,
    );
  });
});

describe("PaymentsService.confirmPayment (the return page)", () => {
  function awaitingOrder(): void {
    repository.seedOrder(orderSnapshot({ status: "AWAITING_PAYMENT" }), [orderLine()]);
    repository.seedPayment(paymentSnapshot());
  }

  it("reads the transaction from Wompi and settles it through the shared settlement", async () => {
    awaitingOrder();
    wompi.seed(wompiTransaction());

    const status = await service.confirmPayment("AK-2026-000123", "1234-1700000000-00001");

    expect(wompi.lookups).toEqual(["1234-1700000000-00001"]);
    expect(status).toMatchObject({ status: "PAID", isPaid: true });
    expect(repository.providerEvents.map((event) => event.id)).toEqual([
      "wompi:1234-1700000000-00001:APPROVED",
    ]);
  });

  it("REFUSES a transaction whose reference belongs to another order", async () => {
    awaitingOrder();
    const other = orderSnapshot({
      id: "22222222-2222-4222-8222-222222222299",
      orderNumber: "AK-2026-000777",
      status: "AWAITING_PAYMENT",
    });
    repository.seedOrder(other, [orderLine()]);
    repository.seedPayment(
      paymentSnapshot({ id: "pay_other", orderId: other.id, providerReference: "AK-2026-000777-1" }),
    );
    wompi.seed(wompiTransaction({ id: "tx_other", reference: "AK-2026-000777-1" }));

    const status = await service.confirmPayment("AK-2026-000123", "tx_other");

    expect(status.status).toBe("AWAITING_PAYMENT");
    expect(repository.order(other.id).status).toBe("AWAITING_PAYMENT");
    // Rolled back: the key stays free for the order it really belongs to.
    expect(repository.providerEvents).toHaveLength(0);
  });

  it("does not settle a transaction for the wrong amount — it flags it", async () => {
    awaitingOrder();
    wompi.seed(wompiTransaction({ amount_in_cents: 100 }));

    const status = await service.confirmPayment("AK-2026-000123", "1234-1700000000-00001");

    expect(status).toMatchObject({ status: "PAYMENT_MISMATCH", isPaid: false });
  });

  it("answers with the current status when Wompi does not know the id", async () => {
    awaitingOrder();

    const status = await service.confirmPayment("AK-2026-000123", "nope");

    expect(status.status).toBe("AWAITING_PAYMENT");
  });

  it("never fails the page when Wompi is down", async () => {
    awaitingOrder();
    wompi.failNext = new PaymentProviderUnavailableError("getTransaction", "timeout");

    await expect(
      service.confirmPayment("AK-2026-000123", "1234-1700000000-00001"),
    ).resolves.toMatchObject({ status: "AWAITING_PAYMENT" });
  });

  it("makes no Wompi call for an order that is not awaiting payment", async () => {
    repository.seedOrder(orderSnapshot({ status: "PAID" }));

    await service.confirmPayment("AK-2026-000123", "1234-1700000000-00001");

    expect(wompi.lookups).toHaveLength(0);
  });

  it("is a no-op the second time — the webhook and the page share one dedupe key", async () => {
    awaitingOrder();
    wompi.seed(wompiTransaction());

    await service.confirmPayment("AK-2026-000123", "1234-1700000000-00001");
    await service.confirmPayment("AK-2026-000123", "1234-1700000000-00001");

    expect(repository.committedReservationOrders).toHaveLength(1);
    expect(repository.invoiceNumbersIssued).toHaveLength(1);
  });

  it("404s on an unknown order", async () => {
    await expect(service.confirmPayment("AK-2026-999999", "x")).rejects.toThrow(
      OrderNotFoundError,
    );
  });
});

describe("PaymentsService.reconcileStalledPayments (the sweep)", () => {
  it("asks Wompi about stalled transactions and settles what it learns", async () => {
    repository.seedOrder(orderSnapshot({ status: "AWAITING_PAYMENT" }), [orderLine()]);
    repository.seedPayment(
      paymentSnapshot({ status: "PROCESSING", providerPaymentId: "1234-1700000000-00001" }),
    );
    repository.stalled = [
      { transactionId: "1234-1700000000-00001", orderNumber: "AK-2026-000123" },
    ];
    wompi.seed(wompiTransaction());

    expect(await service.reconcileStalledPayments(NOW)).toBe(1);
    expect(repository.order().status).toBe("PAID");
  });

  it("keeps going when one lookup fails", async () => {
    repository.seedOrder(orderSnapshot({ status: "AWAITING_PAYMENT" }), [orderLine()]);
    repository.seedPayment(paymentSnapshot({ status: "PROCESSING", providerPaymentId: "tx_a" }));
    repository.stalled = [
      { transactionId: "tx_a", orderNumber: "AK-2026-000123" },
      { transactionId: "1234-1700000000-00001", orderNumber: "AK-2026-000123" },
    ];
    wompi.failNext = new Error("boom");
    wompi.seed(wompiTransaction());

    await expect(service.reconcileStalledPayments(NOW)).resolves.toBe(2);
    expect(wompi.lookups).toEqual(["tx_a", "1234-1700000000-00001"]);
  });

  it("does nothing with payments disabled", async () => {
    useEnv({ PAYMENTS_ENABLED: "false" });
    repository.stalled = [{ transactionId: "tx", orderNumber: "AK-2026-000123" }];

    expect(await service.reconcileStalledPayments(NOW)).toBe(0);
    expect(wompi.lookups).toHaveLength(0);
  });

  it("only waits ten minutes before asking", () => {
    expect(STALLED_TRANSACTION_AGE_MS).toBe(10 * 60 * 1000);
  });
});
