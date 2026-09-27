import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadBatchCoa, uploadCoaPdf } from "./upload-batch-coa";

/**
 * The two-step COA upload — presign, then PUT straight to storage. Mirrors
 * `upload-product-image.test.ts`: the ORDER is the property worth pinning,
 * since recording the batch's COA before the bytes are stored produces a
 * certificate link that 404s.
 */

/**
 * Mocks built as named values rather than spread over defaults — see
 * `upload-product-image.test.ts`'s own note on why a spread over a default
 * widens the type and makes `.mock` unreachable.
 */
function deps(attach = vi.fn().mockResolvedValue({ ok: true, data: { id: "b1" } })) {
  const requestUpload = vi.fn().mockResolvedValue({
    ok: true,
    data: { uploadUrl: "https://storage.test/put", objectKey: "coa/b1/k.pdf" },
  });
  return { requestUpload, attach };
}

const file = (bytes = 512, type = "application/pdf") =>
  new File([new Uint8Array(bytes)], "coa.pdf", { type });
const input = { batchId: "b1", file: file() };

describe("uploadBatchCoa", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores the bytes BEFORE recording the attach", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    const d = deps();
    await uploadBatchCoa(d, input);

    const put = vi.mocked(globalThis.fetch).mock.invocationCallOrder[0] ?? 0;
    const attach = d.attach.mock.invocationCallOrder[0] ?? 0;
    expect(put).toBeLessThan(attach);
  });

  it("PUTs with the PDF content type and no Authorization header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    await uploadBatchCoa(deps(), input);

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("content-type")).toBe("application/pdf");
    // The signed URL carries its own authority; the admin bearer must never
    // reach the browser's network tab.
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("attaches the object key the upload URL was minted for", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    const d = deps();
    await uploadBatchCoa(d, input);

    expect(d.attach).toHaveBeenCalledWith("b1", { objectKey: "coa/b1/k.pdf" });
  });

  it("refuses a non-PDF file, before requesting a URL", async () => {
    const d = deps();
    const outcome = await uploadBatchCoa(d, { ...input, file: file(512, "image/png") });
    expect(outcome).toEqual({ ok: false, reason: "notAPdf" });
    expect(d.requestUpload).not.toHaveBeenCalled();
  });

  it("refuses an oversized file, before requesting a URL", async () => {
    const d = deps();
    const outcome = await uploadBatchCoa(d, { ...input, file: file(11 * 1024 * 1024) });
    expect(outcome).toEqual({ ok: false, reason: "tooLarge" });
    expect(d.requestUpload).not.toHaveBeenCalled();
  });

  it("reports a sign failure distinctly, before any bytes move", async () => {
    const d = {
      requestUpload: vi.fn().mockResolvedValue({ ok: false, code: "INTERNAL_ERROR", reason: null, message: "x" }),
      attach: vi.fn(),
    };
    vi.stubGlobal("fetch", vi.fn());
    const outcome = await uploadBatchCoa(d, input);
    expect(outcome).toEqual({ ok: false, reason: "signFailed" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does NOT attach when the storage PUT fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));
    const d = deps();
    expect(await uploadBatchCoa(d, input)).toEqual({ ok: false, reason: "uploadFailed" });
    expect(d.attach).not.toHaveBeenCalled();
  });

  it("reports an attach failure distinctly — the bytes ARE stored", async () => {
    // Different recovery: the object exists and is orphaned, rather than a
    // batch that believes it has a certificate it does not.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    const d = deps(vi.fn().mockResolvedValue({ ok: false, code: "CONFLICT", reason: null, message: "x" }));
    expect(await uploadBatchCoa(d, input)).toEqual({ ok: false, reason: "attachFailed" });
  });
});

describe("uploadCoaPdf — the same dance for the PRODUCT's certificate", () => {
  afterEach(() => vi.unstubAllGlobals());

  function productDeps() {
    return {
      requestUpload: vi.fn().mockResolvedValue({
        ok: true,
        data: { uploadUrl: "https://storage.test/put", objectKey: "coa/products/p1/k.pdf" },
      }),
      attach: vi.fn().mockResolvedValue({ ok: true, data: { id: "p1" } }),
    };
  }

  it("presigns for the file's size, PUTs, then attaches the minted key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    const d = productDeps();

    expect(await uploadCoaPdf(d, file(2048))).toEqual({ ok: true });
    expect(d.requestUpload).toHaveBeenCalledWith(2048);
    expect(d.attach).toHaveBeenCalledWith("coa/products/p1/k.pdf");
    const put = vi.mocked(globalThis.fetch).mock.invocationCallOrder[0] ?? 0;
    expect(put).toBeLessThan(d.attach.mock.invocationCallOrder[0] ?? 0);
  });

  it("applies the same PDF-only and 10 MB checks before asking for a URL", async () => {
    const d = productDeps();

    expect(await uploadCoaPdf(d, file(512, "image/png"))).toEqual({ ok: false, reason: "notAPdf" });
    expect(await uploadCoaPdf(d, file(11 * 1024 * 1024))).toEqual({
      ok: false,
      reason: "tooLarge",
    });
    expect(d.requestUpload).not.toHaveBeenCalled();
  });
});
