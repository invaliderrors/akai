import "reflect-metadata";
import { PATH_METADATA } from "@nestjs/common/constants";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { RecordNotFoundError } from "@akai/db";
import { createLogger } from "@akai/observability";
import { httpServerOf } from "@akai/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { AllExceptionsFilter } from "../../common/filters/all-exceptions.filter";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import {
  attachPrincipal,
  customerPrincipal,
  rolesGuardProvider,
} from "../../testing/authenticated-app";
import type { Principal } from "../auth/security/principal";

const ALICE = customerPrincipal({ customerId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" });
const MALLORY = customerPrincipal({ customerId: "3f2504e0-4f89-41d3-9a0c-0305e82c33ff" });

let app: INestApplication;

/**
 * Every method on this service takes the OWNING customer id first — that is the
 * ownership scoping this suite exists to prove — so the stub is typed on that
 * first parameter rather than left as `ReturnType<typeof vi.fn>`, which is
 * `Mock<(...args: any[]) => any>` and made `mock.calls[0]` an `any[]`. The id
 * read back below is the single most important value in the file; it must not
 * be an `any`.
 */
type ScopedOrdersFn = (customerId: string, ...rest: readonly unknown[]) => Promise<unknown>;

let ordersStub: Record<string, Mock<ScopedOrdersFn>>;
let currentUser: Principal | null = ALICE;

beforeAll(async () => {
  ordersStub = {
    listForCustomer: vi.fn<ScopedOrdersFn>(async () => ({
      items: [],
      nextCursor: null,
      hasMore: false,
    })),
    getForCustomer: vi.fn<ScopedOrdersFn>(async () => ({ orderNumber: "AK-2026-000123" })),
    getStatusForCustomer: vi.fn<ScopedOrdersFn>(async () => ({
      orderNumber: "AK-2026-000123",
      status: "PAID",
      isPaid: true,
      isTerminal: false,
    })),
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [OrdersController],
    providers: [{ provide: OrdersService, useValue: ordersStub }, rolesGuardProvider],
  }).compile();

  app = moduleRef.createNestApplication();
  attachPrincipal(app, () => currentUser);
  app.useGlobalFilters(
    new AllExceptionsFilter(
      createLogger({ level: "silent", nodeEnv: "test", serviceName: "orders-test" }),
      false,
    ),
  );
  await app.init();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  currentUser = ALICE;
  for (const stub of Object.values(ordersStub)) {
    stub.mockClear();
  }
});

describe("OrdersController — customer scoping", () => {
  /**
   * THE structural assertion.
   *
   * No route on this controller may contain a customer id segment. The
   * alternative shape, `/customers/:customerId/orders`, puts the ownership key
   * in attacker-controlled space and then relies on every handler remembering
   * to compare it against the session — which is the comparison people forget.
   *
   * Asserted by reflection so a future route cannot reintroduce the pattern.
   */
  it("exposes no route carrying a customer id", () => {
    const prototype: object = OrdersController.prototype;
    const paths: string[] = [];

    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor") {
        continue;
      }
      const handler: unknown = Object.getOwnPropertyDescriptor(prototype, name)?.value;
      if (typeof handler !== "function") {
        continue;
      }
      const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
      if (typeof path === "string") {
        paths.push(path);
      }
    }

    expect(paths.length).toBeGreaterThanOrEqual(3);
    for (const path of paths) {
      expect(path.toLowerCase()).not.toContain("customer");
      expect(path.toLowerCase()).not.toContain(":userid");
    }
  });

  it("passes the SESSION's customer id into the service", async () => {
    await request(httpServerOf(app)).get("/orders").expect(200);

    expect(ordersStub["listForCustomer"]).toHaveBeenCalledTimes(1);
    const [customerId] = ordersStub["listForCustomer"]?.mock.calls[0] ?? [];
    expect(customerId).toBe(ALICE.customerId);
  });

  /**
   * A customer id smuggled through the query string is REJECTED, not ignored.
   *
   * Ignoring it would already be safe — the handler reads `actor.customerId` and
   * never looks at the query — but rejecting is strictly better: a stripped-but-
   * accepted parameter can be resurrected by a future handler that starts
   * reading `query.customerId`, whereas a request that 400s never reaches one.
   * This is `.strict()` on the pagination schema doing exactly its job.
   */
  it("rejects a customer id smuggled through the query string", async () => {
    const response = await request(httpServerOf(app)).get(
      `/orders?customerId=${MALLORY.customerId}`,
    );

    expect(response.status).toBe(400);
    expect(ordersStub["listForCustomer"]).not.toHaveBeenCalled();
  });

  it("does the same on the detail and status routes", async () => {
    await request(httpServerOf(app)).get("/orders/AK-2026-000123").expect(200);
    expect(ordersStub["getForCustomer"]?.mock.calls[0]?.[0]).toBe(ALICE.customerId);

    await request(httpServerOf(app)).get("/orders/AK-2026-000123/status").expect(200);
    expect(ordersStub["getStatusForCustomer"]?.mock.calls[0]?.[0]).toBe(ALICE.customerId);
  });

  it("401s when no verified actor is present", async () => {
    // These routes carry no @Public(), so the global JwtAuthGuard covers them —
    // but @CurrentUser refuses independently, so they stay closed even if that
    // guard is misconfigured. Two locks, because the cost is one decorator.
    currentUser = null;

    await request(httpServerOf(app)).get("/orders").expect(401);
    await request(httpServerOf(app)).get("/orders/AK-2026-000123").expect(401);
    expect(ordersStub["listForCustomer"]).not.toHaveBeenCalled();
  });

  it("surfaces another customer's order as 404, never 403", async () => {
    // The service's scoped query found nothing. A 403 would confirm the order
    // exists; order numbers are sequential, so that turns the endpoint into an
    // oracle for the store's entire order volume.
    ordersStub["getForCustomer"]?.mockRejectedValueOnce(new RecordNotFoundError("Order"));

    const response = await request(httpServerOf(app)).get("/orders/AK-2026-000999");

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("FORBIDDEN");
  });

  it("rejects a malformed order number before it reaches the service", async () => {
    const response = await request(httpServerOf(app)).get("/orders/../../etc/passwd");

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(ordersStub["getForCustomer"]).not.toHaveBeenCalled();
  });

  it("rejects an unknown query parameter rather than silently ignoring it", async () => {
    const response = await request(httpServerOf(app)).get("/orders?limit=5&sneaky=1");

    expect(response.status).toBe(400);
    expect(ordersStub["listForCustomer"]).not.toHaveBeenCalled();
  });

  it("caps the page size so one request cannot pull the whole history", async () => {
    const response = await request(httpServerOf(app)).get("/orders?limit=100000");

    expect(response.status).toBe(400);
    expect(ordersStub["listForCustomer"]).not.toHaveBeenCalled();
  });
});
