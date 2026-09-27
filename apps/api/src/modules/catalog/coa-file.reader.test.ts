import { describe, expect, it, vi } from "vitest";

import { COA_FILE_MAX_BYTES, CoaFileReadError, S3CoaFileReader } from "./coa-file.reader";

/**
 * The server-side read behind `GET /v1/products/:slug/coa/file`. What is
 * pinned: it reads the PRIVATE bucket through a seconds-long presigned GET, a
 * missing object is the same 404 as a missing certificate, and nothing over
 * the upload cap is ever buffered whole — whether the store declares the size
 * or not.
 */

const NOW = new Date("2026-09-24T10:00:00.000Z");
const OPTIONS = {
  endpoint: "http://localhost:9000",
  bucket: "akai-coa",
  region: "us-east-1",
  accessKeyId: "key",
  secretAccessKey: "secret",
};
const KEY = "coa/products/p1/2026-09-24T10-00-00-000Z-aaaa.pdf";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"

function readerWith(fetchImpl: typeof fetch, maxBytes?: number): S3CoaFileReader {
  return new S3CoaFileReader(
    maxBytes === undefined ? OPTIONS : { ...OPTIONS, maxBytes },
    { now: () => NOW },
    fetchImpl,
  );
}

/** A body delivered in several chunks and WITHOUT a Content-Length. */
function chunkedResponse(chunks: readonly Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("S3CoaFileReader", () => {
  it("GETs the object through a short-lived presigned URL on the private bucket", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(PDF, { status: 200 }));

    const bytes = await readerWith(fetchImpl).read(KEY);

    expect(Array.from(bytes)).toEqual(Array.from(PDF));
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe("http://localhost:9000");
    expect(parsed.pathname).toBe(`/akai-coa/${KEY}`);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(init?.method).toBe("GET");
  });

  it("reassembles a chunked body in order", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      chunkedResponse([PDF.slice(0, 3), PDF.slice(3, 5), PDF.slice(5)]),
    );

    const bytes = await readerWith(fetchImpl).read(KEY);

    expect(Array.from(bytes)).toEqual(Array.from(PDF));
  });

  it("maps a missing object to the certificate's 404", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("NoSuchKey", { status: 404 }));

    await expect(readerWith(fetchImpl).read(KEY)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails loudly — not as a 404 — when the store refuses or breaks", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("denied", { status: 403 }));

    await expect(readerWith(fetchImpl).read(KEY)).rejects.toBeInstanceOf(CoaFileReadError);
  });

  it("refuses a DECLARED size over the cap before reading the body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(PDF, {
          status: 200,
          headers: { "content-length": String(COA_FILE_MAX_BYTES + 1) },
        }),
    );

    await expect(readerWith(fetchImpl).read(KEY)).rejects.toBeInstanceOf(CoaFileReadError);
  });

  it("abandons an UNDECLARED body as soon as it passes the cap", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      chunkedResponse([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)]),
    );

    await expect(readerWith(fetchImpl, 6).read(KEY)).rejects.toThrow(/exceeded the 6-byte cap/);
  });

  it("caps at the 10 MB upload limit by default", () => {
    expect(COA_FILE_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
