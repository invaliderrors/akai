import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { errorEnvelopeSchema } from "@akai/contracts";
import { createLogger } from "@akai/observability";
import { httpServerOf } from "@akai/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AllExceptionsFilter } from "../../../common/filters/all-exceptions.filter";
import {
  attachPrincipal,
  customerPrincipal,
  rolesGuardProvider,
  staffPrincipal,
} from "../../../testing/authenticated-app";
import type { Principal } from "../../auth/security/principal";
import { IdempotencyService, type IdempotentExecution } from "../../idempotency/idempotency.service";
import { FulfilmentError } from "../fulfilment.errors";
import { FulfilmentAdminController } from "./fulfilment-admin.controller";
import { FulfilmentAdminService } from "./fulfilment-admin.service";

/**
 * The staff label surface. Like the orders sweep, the route table is
 * DISCOVERED by reflection, so a route added later inherits the CUSTOMER-403
 * assertion without anyone remembering to list it.
 */

const CUSTOMER = customerPrincipal();
const STAFF = staffPrincipal();
const ORDER = "11111111-1111-4111-8111-111111111111";
const SHIPMENT = "ffffffff-0000-4000-8000-000000000001";

function readMetadata(key: string, target: object): unknown {
  return Reflect.getMetadata(key, target);
}

const HTTP_VERB: Readonly<Record<number, "get" | "post">> = {
  [RequestMethod.GET]: "get",
  [RequestMethod.POST]: "post",
};

function discoverRoutes(): { verb: "get" | "post"; url: string }[] {
  const base = readMetadata(PATH_METADATA, FulfilmentAdminController);
  const basePath = typeof base === "string" ? base : "";
  const prototype: object = FulfilmentAdminController.prototype;
  const routes: { verb: "get" | "post"; url: string }[] = [];
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const handler: unknown = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    if (name === "constructor" || typeof handler !== "function") continue;
    const path = readMetadata(PATH_METADATA, handler);
    const method = readMetadata(METHOD_METADATA, handler);
    if (typeof path !== "string" || typeof method !== "number") continue;
    const verb = HTTP_VERB[method];
    if (verb === undefined) continue;
    routes.push({ verb, url: `/${basePath}/${path}`.replace(":shipmentId", SHIPMENT) });
  }
  return routes;
}

const ROUTES = discoverRoutes();

const serviceStub = {
  enqueueLabels: vi.fn(async () => ({ accepted: ["AK-2026-000001"], skipped: [] })),
  print: vi.fn(async () => ({
    pdf: new Uint8Array([37, 80, 68, 70]),
    count: 1,
    skippedOrderIds: ["22222222-2222-4222-8222-222222222222"],
  })),
  labelUrl: vi.fn(async () => "https://s3.test/akai-private/labels/o/1.pdf?X-Amz-Signature=abc"),
  cancel: vi.fn(async () => ({ shipmentId: SHIPMENT, status: "CANCELLED", orderStatus: "PAID" })),
  retry: vi.fn(async () => ({ accepted: ["AK-2026-000001"], skipped: [] })),
};

/** Runs the handler straight through: the reservation mechanics are IdempotencyService's own test. */
const idempotencyStub = {
  execute: vi.fn(async (execution: IdempotentExecution<unknown>) => ({
    value: await execution.handler(),
    replayed: false,
  })),
};

let app: INestApplication;
let currentUser: Principal | null = CUSTOMER;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [FulfilmentAdminController],
    providers: [
      { provide: FulfilmentAdminService, useValue: serviceStub },
      { provide: IdempotencyService, useValue: idempotencyStub },
      rolesGuardProvider,
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  attachPrincipal(app, () => currentUser);
  app.useGlobalFilters(
    new AllExceptionsFilter(
      createLogger({ level: "silent", nodeEnv: "test", serviceName: "fulfilment-test" }),
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
  for (const stub of Object.values(serviceStub)) stub.mockClear();
  idempotencyStub.execute.mockClear();
});

describe("FulfilmentAdminController — privileged surface", () => {
  it("discovers all five routes", () => {
    expect(ROUTES).toHaveLength(5);
  });

  it.each(ROUTES)("refuses a CUSTOMER on $verb $url", async ({ verb, url }) => {
    const response = await request(httpServerOf(app))[verb](url)
      .set("idempotency-key", "k")
      .send({ orderIds: [ORDER] });
    expect(response.status).toBe(403);
  });

  it("refuses an anonymous caller on every route, and never reaches the service", async () => {
    currentUser = null;
    for (const { verb, url } of ROUTES) {
      const response = await request(httpServerOf(app))[verb](url).send({ orderIds: [ORDER] });
      expect(response.status, `${verb} ${url}`).toBe(401);
    }
    for (const stub of Object.values(serviceStub)) expect(stub).not.toHaveBeenCalled();
  });
});

describe("FulfilmentAdminController — staff", () => {
  beforeEach(() => {
    currentUser = STAFF;
  });

  it("generate: 202 with the split, idempotent under the caller's key, actor recorded", async () => {
    const response = await request(httpServerOf(app))
      .post("/admin/fulfilment/labels")
      .set("idempotency-key", "key-1")
      .send({ orderIds: [ORDER] });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: ["AK-2026-000001"], skipped: [] });
    expect(idempotencyStub.execute).toHaveBeenCalledWith(
      expect.objectContaining({ key: "key-1", userId: STAFF.customerId, route: "POST /admin/fulfilment/labels" }),
    );
    expect(serviceStub.enqueueLabels).toHaveBeenCalledWith([ORDER], STAFF.customerId);
  });

  it.each([
    ["POST", "/admin/fulfilment/labels"],
    ["POST", `/admin/fulfilment/shipments/${SHIPMENT}/cancel`],
    ["POST", `/admin/fulfilment/shipments/${SHIPMENT}/retry`],
  ])("%s %s requires an Idempotency-Key", async (_verb, url) => {
    const response = await request(httpServerOf(app)).post(url).send({ orderIds: [ORDER] });
    expect(response.status).toBe(400);
    expect(idempotencyStub.execute).not.toHaveBeenCalled();
  });

  it("generate: rejects more than 100 orders and duplicates before the service", async () => {
    const tooMany = Array.from(
      { length: 101 },
      (_unused, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    );
    const big = await request(httpServerOf(app))
      .post("/admin/fulfilment/labels")
      .set("idempotency-key", "k")
      .send({ orderIds: tooMany });
    const dup = await request(httpServerOf(app))
      .post("/admin/fulfilment/labels")
      .set("idempotency-key", "k")
      .send({ orderIds: [ORDER, ORDER] });

    expect(big.status).toBe(400);
    expect(dup.status).toBe(400);
    expect(serviceStub.enqueueLabels).not.toHaveBeenCalled();
  });

  it("print: streams application/pdf and names the skipped orders in a header", async () => {
    const response = await request(httpServerOf(app))
      .post("/admin/fulfilment/labels/print")
      .send({ orderIds: [ORDER] })
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["x-labels-skipped"]).toBe("22222222-2222-4222-8222-222222222222");
    expect(response.headers["x-labels-count"]).toBe("1");
    expect(Buffer.isBuffer(response.body) ? Array.from(response.body) : []).toEqual([37, 80, 68, 70]);
  });

  it("print: 409 LABEL_NOT_AVAILABLE when nothing can be printed", async () => {
    serviceStub.print.mockRejectedValueOnce(FulfilmentError.from("LABEL_NOT_AVAILABLE"));

    const response = await request(httpServerOf(app))
      .post("/admin/fulfilment/labels/print")
      .send({ orderIds: [ORDER] });

    expect(response.status).toBe(409);
    expect(errorEnvelopeSchema.parse(response.body).error.reason).toBe("LABEL_NOT_AVAILABLE");
  });

  it("label: 302 to the signed URL, never cached", async () => {
    const response = await request(httpServerOf(app)).get(
      `/admin/fulfilment/shipments/${SHIPMENT}/label`,
    );

    expect(response.status).toBe(302);
    expect(response.headers["location"]).toBe(
      "https://s3.test/akai-private/labels/o/1.pdf?X-Amz-Signature=abc",
    );
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("label: validates the shipment id before the service", async () => {
    const response = await request(httpServerOf(app)).get("/admin/fulfilment/shipments/nope/label");
    expect(response.status).toBe(400);
    expect(serviceStub.labelUrl).not.toHaveBeenCalled();
  });

  it("cancel: 200 with the outcome; a carrier refusal is a coded 409", async () => {
    const ok = await request(httpServerOf(app))
      .post(`/admin/fulfilment/shipments/${SHIPMENT}/cancel`)
      .set("idempotency-key", "k");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ shipmentId: SHIPMENT, status: "CANCELLED", orderStatus: "PAID" });

    serviceStub.cancel.mockRejectedValueOnce(FulfilmentError.from("CANCEL_REJECTED"));
    const refused = await request(httpServerOf(app))
      .post(`/admin/fulfilment/shipments/${SHIPMENT}/cancel`)
      .set("idempotency-key", "k2");
    expect(refused.status).toBe(409);
    expect(errorEnvelopeSchema.parse(refused.body).error.reason).toBe("CANCEL_REJECTED");
  });

  it("retry: 202 with the split", async () => {
    const response = await request(httpServerOf(app))
      .post(`/admin/fulfilment/shipments/${SHIPMENT}/retry`)
      .set("idempotency-key", "k");
    expect(response.status).toBe(202);
    expect(serviceStub.retry).toHaveBeenCalledWith(SHIPMENT, STAFF.customerId);
  });
});
