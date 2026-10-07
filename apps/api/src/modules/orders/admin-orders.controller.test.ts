import "reflect-metadata";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import type { INestApplication } from "@nestjs/common";
import { RequestMethod } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createLogger } from "@akai/observability";
import { httpServerOf } from "@akai/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AllExceptionsFilter } from "../../common/filters/all-exceptions.filter";
import {
  attachPrincipal,
  customerPrincipal,
  rolesGuardProvider,
  staffPrincipal,
} from "../../testing/authenticated-app";
import type { Principal } from "../auth/security/principal";
import { AdminOrdersController } from "./admin-orders.controller";
import { OrdersService } from "./orders.service";

/**
 * The privileged-surface sweep.
 *
 * The spec requires a test in which a CUSTOMER token hitting EVERY `/admin/*`
 * route gets 403. The important word is "every": a hand-written list of routes
 * protects the routes somebody remembered, and the endpoint added in six months
 * during an incident is exactly the one that will be missed.
 *
 * So the route table is DISCOVERED by reflection from the controller's own Nest
 * metadata. A new handler is automatically covered; there is no list to forget
 * to update.
 */

const CUSTOMER = customerPrincipal();
const STAFF = staffPrincipal();

/** `Reflect.getMetadata` is typed `any`; funnel it through `unknown` instead. */
function readMetadata(key: string, target: object): unknown {
  return Reflect.getMetadata(key, target);
}

const HTTP_VERB: Readonly<Record<number, "get" | "post" | "patch" | "put" | "delete">> = {
  [RequestMethod.GET]: "get",
  [RequestMethod.POST]: "post",
  [RequestMethod.PUT]: "put",
  [RequestMethod.DELETE]: "delete",
  [RequestMethod.PATCH]: "patch",
};

interface DiscoveredRoute {
  readonly handlerName: string;
  readonly verb: "get" | "post" | "patch" | "put" | "delete";
  readonly url: string;
}

/** Substitute a valid-looking value for each path parameter. */
function fillParams(path: string): string {
  return path
    .replace(":orderNumber", "AK-2026-000123")
    .replace(":shipmentId", "ffffffff-0000-4000-8000-000000000001");
}

function discoverRoutes(): DiscoveredRoute[] {
  const base = readMetadata(PATH_METADATA, AdminOrdersController);
  const basePath = typeof base === "string" ? base : "";

  const prototype: object = AdminOrdersController.prototype;
  const routes: DiscoveredRoute[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === "constructor") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const handler: unknown = descriptor?.value;
    if (typeof handler !== "function") {
      continue;
    }

    const path = readMetadata(PATH_METADATA, handler);
    const method = readMetadata(METHOD_METADATA, handler);
    if (typeof path !== "string" || typeof method !== "number") {
      continue;
    }

    const verb = HTTP_VERB[method];
    if (verb === undefined) {
      continue;
    }

    const suffix = path === "/" ? "" : `/${path}`;
    routes.push({ handlerName: name, verb, url: fillParams(`/${basePath}${suffix}`) });
  }

  return routes;
}

const ROUTES = discoverRoutes();

/** Every method the controller delegates to, stubbed to a benign success. */
function createOrdersServiceStub(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    listForAdmin: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    getForAdmin: vi.fn(async () => ({ orderNumber: "AK-2026-000123" })),
    transitionByAdmin: vi.fn(async () => ({ orderNumber: "AK-2026-000123" })),
    createShipment: vi.fn(async () => ({ id: "shipment" })),
    markShipmentDelivered: vi.fn(async () => ({ id: "shipment" })),
    recordRefund: vi.fn(async () => ({ id: "refund" })),
  };
}

let app: INestApplication;
let ordersStub: Record<string, ReturnType<typeof vi.fn>>;
/** Mutated per test to impersonate a different caller. */
let currentUser: Principal | null = CUSTOMER;

beforeAll(async () => {
  ordersStub = createOrdersServiceStub();

  const moduleRef = await Test.createTestingModule({
    controllers: [AdminOrdersController],
    providers: [{ provide: OrdersService, useValue: ordersStub }, rolesGuardProvider],
  }).compile();

  app = moduleRef.createNestApplication();

  // Stands in for the global JwtAuthGuard only. The RolesGuard registered
  // above is the REAL one, so the authorisation decision under test is the
  // production code path — not a copy of it that could drift.
  attachPrincipal(app, () => currentUser);

  // The SAME filter main.ts installs. Without it a ZodError surfaces as a raw
  // 500, so the validation assertions below would be testing the absence of a
  // filter rather than the presence of validation — and a 500 on malformed
  // input is itself a defect (it pages an on-call engineer for a typo).
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
  currentUser = CUSTOMER;
  for (const stub of Object.values(ordersStub)) {
    stub.mockClear();
  }
});

describe("AdminOrdersController — privileged surface", () => {
  it("discovers every route on the controller", () => {
    // Guards against the sweep silently passing because reflection found
    // nothing: zero routes tested is indistinguishable from all routes passing.
    expect(ROUTES.length).toBeGreaterThanOrEqual(6);
    expect(ROUTES.every((route) => route.url.startsWith("/admin/orders"))).toBe(true);
  });

  it.each(ROUTES)(
    "refuses a CUSTOMER on $verb $url ($handlerName)",
    async ({ verb, url }) => {
      const response = await request(httpServerOf(app))[verb](url).send({});

      expect(response.status).toBe(403);
    },
  );

  it("never reaches the service when a CUSTOMER is refused", async () => {
    // A 403 produced AFTER the handler ran would still have read (or written)
    // another customer's order. The guard must short-circuit before delegation.
    for (const route of ROUTES) {
      await request(httpServerOf(app))[route.verb](route.url).send({});
    }

    for (const [name, stub] of Object.entries(ordersStub)) {
      expect(stub, `${name} must not run for a CUSTOMER`).not.toHaveBeenCalled();
    }
  });

  /**
   * 401, not 403.
   *
   * The module-local AdminOnlyGuard this suite originally exercised answered
   * 403 to an anonymous caller, on the reasoning that a privileged route should
   * not hint at which credential would have worked. The canonical guard splits
   * the two questions: JwtAuthGuard owns "who are you" (401) and RolesGuard
   * owns "may you do this" (403). That is the better boundary — conflating them
   * means a client cannot tell "log in again" from "you will never be allowed",
   * and the dashboard needs to distinguish those to decide whether to redirect
   * to sign-in or show an error.
   *
   * No information leaks either way: an anonymous caller learns the route needs
   * authentication, which is true of every route on the API.
   */
  it("refuses an unauthenticated caller on every route", async () => {
    currentUser = null;

    for (const route of ROUTES) {
      const response = await request(httpServerOf(app))[route.verb](route.url).send({});
      expect(response.status, `${route.verb} ${route.url}`).toBe(401);
    }
  });

  it("refuses a forged privileged role supplied in the body or query", async () => {
    // The principal stays CUSTOMER; the attacker-controlled fields claim ADMIN.
    const response = await request(httpServerOf(app))
      .get("/admin/orders?role=ADMIN")
      .send({ role: "ADMIN" });

    expect(response.status).toBe(403);
    expect(ordersStub["listForAdmin"]).not.toHaveBeenCalled();
  });

  /**
   * The control. Without this, every assertion above would pass just as well
   * against a controller whose routes are misspelled and return 404 — or
   * against one where the guard rejects everyone including staff.
   */
  it("admits STAFF to the same routes", async () => {
    currentUser = STAFF;

    const list = await request(httpServerOf(app)).get("/admin/orders");
    expect(list.status).toBe(200);
    expect(ordersStub["listForAdmin"]).toHaveBeenCalledTimes(1);

    const detail = await request(httpServerOf(app)).get("/admin/orders/AK-2026-000123");
    expect(detail.status).toBe(200);
  });

  it("validates the order number before it reaches the service", async () => {
    currentUser = STAFF;

    const response = await request(httpServerOf(app)).get("/admin/orders/not-an-order");

    expect(response.status).toBe(400);
    expect(ordersStub["getForAdmin"]).not.toHaveBeenCalled();
  });

  it("rejects an unknown field in a transition body rather than dropping it", async () => {
    currentUser = STAFF;

    // `.strict()` is forbidNonWhitelisted: a stripped-but-accepted field can be
    // re-introduced by a future `data: { ...body }` spread; a rejected one
    // never reaches one.
    const response = await request(httpServerOf(app))
      .patch("/admin/orders/AK-2026-000123/status")
      .send({ status: "FULFILLING", refundedTotal: 0 });

    expect(response.status).toBe(400);
    expect(ordersStub["transitionByAdmin"]).not.toHaveBeenCalled();
  });
});
