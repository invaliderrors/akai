import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createLogger } from "@akai/observability";
import { httpServerOf } from "@akai/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AllExceptionsFilter } from "../../common/filters/all-exceptions.filter";
import { AdminProductsController } from "./admin-products.controller";
import { CatalogError } from "./catalog.errors";
import { ProductInventoryService } from "./product-inventory.service";
import { ProductsService } from "./products.service";

/**
 * The product certificate's three admin routes at the HTTP boundary:
 * `POST :id/coa/upload-url`, `POST :id/coa` and `DELETE :id/coa`.
 *
 * WHO may call them is `admin-products.controller.test.ts`'s job — it reflects
 * over every handler on this controller, these three included, and runs the
 * canonical RolesGuard against CUSTOMER, anonymous, STAFF and ADMIN. This
 * suite pins WHAT reaches the service: the 10 MB ceiling and the strict bodies
 * are enforced before any signing happens, and ids are validated.
 */

const PRODUCT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = `coa/products/${PRODUCT_ID}/2026-09-24T10-00-00-000Z-abcdef.pdf`;

const service = {
  createCoaUploadUrl: vi.fn(async () => ({
    uploadUrl: "https://s3.example.com/akai-coa/put?X-Amz-Signature=abc",
    objectKey: KEY,
    expiresInSeconds: 600,
  })),
  attachCoa: vi.fn(async () => ({ id: PRODUCT_ID })),
  removeCoa: vi.fn(async () => ({ id: PRODUCT_ID })),
};

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminProductsController],
    providers: [
      { provide: ProductsService, useValue: service },
      { provide: ProductInventoryService, useValue: {} },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.useGlobalFilters(
    new AllExceptionsFilter(
      createLogger({ level: "silent", nodeEnv: "test", serviceName: "catalog-test" }),
      false,
    ),
  );
  await app.init();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  service.createCoaUploadUrl.mockClear();
  service.attachCoa.mockClear();
  service.removeCoa.mockClear();
});

describe("POST /admin/products/:id/coa/upload-url", () => {
  it("issues a signed upload url (200 — a capability, nothing created yet)", async () => {
    const response = await request(httpServerOf(app))
      .post(`/admin/products/${PRODUCT_ID}/coa/upload-url`)
      .send({ sizeBytes: 2048 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ objectKey: KEY, expiresInSeconds: 600 });
    expect(service.createCoaUploadUrl).toHaveBeenCalledWith(PRODUCT_ID, { sizeBytes: 2048 });
  });

  it("refuses a file over 10 MB, and any extra field, before signing anything", async () => {
    const tooLarge = await request(httpServerOf(app))
      .post(`/admin/products/${PRODUCT_ID}/coa/upload-url`)
      .send({ sizeBytes: 10 * 1024 * 1024 + 1 });
    const chosenKey = await request(httpServerOf(app))
      .post(`/admin/products/${PRODUCT_ID}/coa/upload-url`)
      .send({ sizeBytes: 2048, objectKey: "coa/products/elsewhere.pdf" });

    expect(tooLarge.status).toBe(400);
    expect(chosenKey.status).toBe(400);
    expect(service.createCoaUploadUrl).not.toHaveBeenCalled();
  });

  it("400s a malformed product id", async () => {
    const response = await request(httpServerOf(app))
      .post("/admin/products/not-a-uuid/coa/upload-url")
      .send({ sizeBytes: 2048 });

    expect(response.status).toBe(400);
    expect(service.createCoaUploadUrl).not.toHaveBeenCalled();
  });
});

describe("POST /admin/products/:id/coa", () => {
  it("records the uploaded key", async () => {
    const response = await request(httpServerOf(app))
      .post(`/admin/products/${PRODUCT_ID}/coa`)
      .send({ objectKey: KEY });

    expect(response.status).toBe(200);
    expect(service.attachCoa).toHaveBeenCalledWith(PRODUCT_ID, { objectKey: KEY });
  });

  it("surfaces the service's refusal of a foreign key as a 400", async () => {
    service.attachCoa.mockRejectedValueOnce(CatalogError.validation("not issued for this product"));

    const response = await request(httpServerOf(app))
      .post(`/admin/products/${PRODUCT_ID}/coa`)
      .send({ objectKey: "coa/products/other/x.pdf" });

    expect(response.status).toBe(400);
  });

  it("400s an empty body", async () => {
    const response = await request(httpServerOf(app))
      .post(`/admin/products/${PRODUCT_ID}/coa`)
      .send({});

    expect(response.status).toBe(400);
    expect(service.attachCoa).not.toHaveBeenCalled();
  });
});

describe("DELETE /admin/products/:id/coa", () => {
  it("removes the certificate and returns the product", async () => {
    const response = await request(httpServerOf(app)).delete(`/admin/products/${PRODUCT_ID}/coa`);

    expect(response.status).toBe(200);
    expect(service.removeCoa).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it("404s an unknown product", async () => {
    service.removeCoa.mockRejectedValueOnce(CatalogError.notFound("Product"));

    const response = await request(httpServerOf(app)).delete(`/admin/products/${PRODUCT_ID}/coa`);

    expect(response.status).toBe(404);
  });
});
