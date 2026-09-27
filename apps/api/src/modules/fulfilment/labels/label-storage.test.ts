import { describe, expect, it, vi } from "vitest";

import { LabelStorageError, S3LabelStorage, labelObjectKey } from "./label-storage";

const NOW = new Date("2026-09-24T10:00:00.000Z");
const OPTIONS = {
  endpoint: "http://localhost:9000",
  bucket: "akai-coa",
  region: "us-east-1",
  accessKeyId: "key",
  secretAccessKey: "secret",
};

function storageWith(fetchImpl: typeof fetch): S3LabelStorage {
  return new S3LabelStorage(OPTIONS, { now: () => NOW }, fetchImpl);
}

describe("labelObjectKey", () => {
  it("is labels/{orderId}/{parcelId}.pdf", () => {
    expect(labelObjectKey("order-1", 412345678)).toBe("labels/order-1/412345678.pdf");
  });
});

describe("S3LabelStorage", () => {
  it("PUTs the bytes through a presigned URL on the private bucket, as a PDF", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const pdf = new Uint8Array([37, 80, 68, 70]);

    await storageWith(fetchImpl).put("labels/o/1.pdf", pdf);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe("http://localhost:9000");
    expect(parsed.pathname).toBe("/akai-coa/labels/o/1.pdf");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(pdf);
    expect(init?.headers).toEqual({ "content-type": "application/pdf" });
  });

  it("throws when the bucket refuses the write, so the job retries", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("denied", { status: 403 }));
    await expect(storageWith(fetchImpl).put("labels/o/1.pdf", new Uint8Array())).rejects.toBeInstanceOf(
      LabelStorageError,
    );
  });

  it("reads an object back through a presigned GET", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    const bytes = await storageWith(fetchImpl).get("labels/o/1.pdf");

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.method).toBe("GET");
  });

  it("throws on a missing object", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    await expect(storageWith(fetchImpl).get("labels/o/1.pdf")).rejects.toBeInstanceOf(
      LabelStorageError,
    );
  });

  it("signs a short-lived download URL without touching the network", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const url = new URL(storageWith(fetchImpl).signedUrl("labels/o/1.pdf"));

    expect(url.pathname).toBe("/akai-coa/labels/o/1.pdf");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
