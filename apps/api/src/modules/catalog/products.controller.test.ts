import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createLogger } from "@akai/observability";
import { httpServerOf } from "@akai/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { AllExceptionsFilter } from "../../common/filters/all-exceptions.filter";
import { ThrottleGuard } from "../throttler/throttle.guard";
import { CatalogError } from "./catalog.errors";
import { COA_FILE_READER, CoaFileReadError } from "./coa-file.reader";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";

/**
 * `GET /products/:slug/coa` — the STABLE link to the product's certificate.
 *
 * The product page is ISR-cached, so it must never embed a signed URL that
 * expires. It links here instead, and this route signs at click time and
 * 302s. What is pinned: the redirect carries exactly the URL the service
 * signed, it is not cacheable, and a certificate that is missing OR hidden by
 * the admin is a 404 (the service decides both; see its own suite).
 */

const SIGNED = "https://s3.example.com/akai-coa/coa/x.pdf?X-Amz-Signature=abc";

let app: INestApplication;
let coaUrlFor: Mock<(slug: string) => Promise<string>>;
let coaObjectKeyFor: Mock<(slug: string) => Promise<string>>;
let readCoa: Mock<(objectKey: string) => Promise<Uint8Array>>;

const OBJECT_KEY = "coa/products/p1/2026-09-24T10-00-00-000Z-aaaa.pdf";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"

beforeAll(async () => {
  coaUrlFor = vi.fn(async () => SIGNED);
  coaObjectKeyFor = vi.fn(async () => OBJECT_KEY);
  readCoa = vi.fn(async () => PDF);

  const moduleRef = await Test.createTestingModule({
    controllers: [ProductsController],
    providers: [
      { provide: ProductsService, useValue: { coaUrlFor, coaObjectKeyFor } },
      { provide: COA_FILE_READER, useValue: { read: readCoa } },
    ],
  })
    .overrideGuard(ThrottleGuard)
    .useValue({ canActivate: () => true })
    .compile();

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
  coaUrlFor.mockClear();
  coaObjectKeyFor.mockClear();
  readCoa.mockClear();
});

describe("GET /products/:slug/coa", () => {
  it("302s to a freshly signed URL for the product's certificate", async () => {
    const response = await request(httpServerOf(app)).get("/products/creatina/coa").redirects(0);

    expect(response.status).toBe(302);
    expect(response.headers["location"]).toBe(SIGNED);
    expect(coaUrlFor).toHaveBeenCalledWith("creatina");
  });

  it("is never cached — the target expires, the link must not", async () => {
    const response = await request(httpServerOf(app)).get("/products/creatina/coa").redirects(0);

    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("404s when the certificate is missing or hidden", async () => {
    coaUrlFor.mockRejectedValueOnce(CatalogError.notFound("Certificate of analysis"));

    const response = await request(httpServerOf(app)).get("/products/creatina/coa").redirects(0);

    expect(response.status).toBe(404);
    expect(response.headers["location"]).toBeUndefined();
  });

  it("still serves a link from a stale page that carried the old ?variantId=", async () => {
    // The previous build linked per variant. A cached page from before the
    // switch must land on the product's certificate, not on a 400.
    const response = await request(httpServerOf(app))
      .get("/products/creatina/coa?variantId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
      .redirects(0);

    expect(response.status).toBe(302);
    expect(coaUrlFor).toHaveBeenCalledWith("creatina");
  });

  it("400s a malformed slug without calling the service", async () => {
    const response = await request(httpServerOf(app)).get("/products/NOT_A_SLUG/coa").redirects(0);

    expect(response.status).toBe(400);
    expect(coaUrlFor).not.toHaveBeenCalled();
  });
});

/**
 * `GET /products/:slug/coa/file` — the certificate AS BYTES, for the
 * storefront's in-page PDF.js viewer. Same visibility decision as the
 * redirect (`coaObjectKeyFor`), served inline with a short PRIVATE cache that
 * is never attached to a failure.
 */
describe("GET /products/:slug/coa/file", () => {
  function getFile(path = "/products/creatina/coa/file") {
    return request(httpServerOf(app))
      .get(path)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
  }

  it("200s with the PDF bytes, inline, under a short private cache", async () => {
    const response = await getFile();

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toBe(
      'inline; filename="certificado-creatina.pdf"',
    );
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(response.headers["content-length"]).toBe(String(PDF.byteLength));
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(Array.from(response.body as Buffer)).toEqual(Array.from(PDF));
    expect(coaObjectKeyFor).toHaveBeenCalledWith("creatina");
    expect(readCoa).toHaveBeenCalledWith(OBJECT_KEY);
  });

  it("404s a missing or hidden certificate WITHOUT reading the bucket or caching the 404", async () => {
    coaObjectKeyFor.mockRejectedValueOnce(CatalogError.notFound("Certificate of analysis"));

    const response = await request(httpServerOf(app)).get("/products/creatina/coa/file");

    expect(response.status).toBe(404);
    expect(readCoa).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).not.toBe("private, max-age=300");
    expect(response.headers["content-type"]).not.toContain("application/pdf");
  });

  it("404s when the row names an object the bucket no longer has", async () => {
    readCoa.mockRejectedValueOnce(CatalogError.notFound("Certificate of analysis"));

    expect((await request(httpServerOf(app)).get("/products/creatina/coa/file")).status).toBe(404);
  });

  it("500s — not 404s — when the store itself fails", async () => {
    readCoa.mockRejectedValueOnce(new CoaFileReadError("store down"));

    expect((await request(httpServerOf(app)).get("/products/creatina/coa/file")).status).toBe(500);
  });

  it("400s a malformed slug without calling the service", async () => {
    const response = await request(httpServerOf(app)).get("/products/NOT_A_SLUG/coa/file");

    expect(response.status).toBe(400);
    expect(coaObjectKeyFor).not.toHaveBeenCalled();
  });
});
