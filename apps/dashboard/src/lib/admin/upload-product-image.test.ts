import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uploadProductImage } from "./upload-product-image";

/**
 * The three-step upload, shared by the edit page's manager and the create form's
 * staged images. The ORDER is the property worth pinning: recording the media row
 * before the bytes are stored produces a product pointing at a 404.
 */

function stubImage(succeeds = true): void {
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 800;
      naturalHeight = 600;
      set src(_v: string) {
        queueMicrotask(() => (succeeds ? this.onload?.() : this.onerror?.()));
      }
    },
  );
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
}

/**
 * Mocks built as named values rather than spread over defaults: a spread widens
 * them to a union with the real signature, and `.mock` is then unreachable —
 * which is a typecheck failure, not a test failure, and reads as nonsense.
 */
function deps(attach = vi.fn().mockResolvedValue({ ok: true, data: { id: "p1" } })) {
  const requestUpload = vi.fn().mockResolvedValue({
    ok: true,
    data: { uploadUrl: "https://storage.test/put", objectKey: "k", publicUrl: "https://cdn.test/k.png" },
  });
  return { requestUpload, attach };
}

const file = (bytes = 512) => new File([new Uint8Array(bytes)], "a.png", { type: "image/png" });
const input = { productId: "p1", file: file(), alt: { es: "Bote" }, sortOrder: 0 };

describe("uploadProductImage", () => {
  beforeEach(() => {
    stubImage();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stores the bytes BEFORE recording the row", async () => {
    const d = deps();
    await uploadProductImage(d, input);

    const put = vi.mocked(globalThis.fetch).mock.invocationCallOrder[0] ?? 0;
    const attach = d.attach.mock.invocationCallOrder[0] ?? 0;
    expect(put).toBeLessThan(attach);
  });

  it("sends the measured dimensions the API requires", async () => {
    const d = deps();
    await uploadProductImage(d, input);
    expect(d.attach.mock.calls[0]?.[1]).toMatchObject({ width: 800, height: 600, sortOrder: 0 });
  });

  it("PUTs without an Authorization header", async () => {
    await uploadProductImage(deps(), input);
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    // The signed URL carries its own authority; the admin bearer must never
    // reach the browser's network tab.
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("refuses a file the browser cannot decode, before requesting a URL", async () => {
    stubImage(false);
    const d = deps();
    expect(await uploadProductImage(d, input)).toEqual({ ok: false, reason: "notAnImage" });
    expect(d.requestUpload).not.toHaveBeenCalled();
  });

  it("refuses an oversized file, before requesting a URL", async () => {
    const d = deps();
    const outcome = await uploadProductImage(d, { ...input, file: file(16 * 1024 * 1024) });
    expect(outcome).toEqual({ ok: false, reason: "tooLarge" });
    expect(d.requestUpload).not.toHaveBeenCalled();
  });

  it("does NOT record a row when the storage PUT fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));
    const d = deps();
    expect(await uploadProductImage(d, input)).toEqual({ ok: false, reason: "uploadFailed" });
    expect(d.attach).not.toHaveBeenCalled();
  });

  it("reports an attach failure distinctly — the bytes ARE stored", async () => {
    // Different recovery: the object exists and is orphaned, rather than the
    // product referencing something that was never written.
    const d = deps(vi.fn().mockResolvedValue({ ok: false, code: "CONFLICT", reason: null, message: "x" }));
    expect(await uploadProductImage(d, input)).toEqual({ ok: false, reason: "attachFailed" });
  });
});
