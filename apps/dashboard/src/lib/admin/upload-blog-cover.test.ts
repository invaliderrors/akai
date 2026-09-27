import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadBlogCover, type BlogCoverUploadDeps } from "./upload-blog-cover";

const POST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const KEY = `blog/${POST_ID}/2026-09-24T10-00-00-000Z-ab.webp`;

function file(type: string, size = 1000): File {
  return new File([new Uint8Array(size)], "cover", { type });
}

function deps(overrides: Partial<BlogCoverUploadDeps> = {}): BlogCoverUploadDeps & {
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    requestUpload: vi.fn(async () => {
      order.push("sign");
      return {
        ok: true as const,
        data: { uploadUrl: "http://s3.test/put", objectKey: KEY, publicUrl: "http://s3.test/c.webp" },
      };
    }),
    attach: vi.fn(async () => {
      order.push("attach");
      return { ok: true as const, data: null };
    }),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadBlogCover", () => {
  it("signs, PUTs the bytes, and only THEN records the key on the post", async () => {
    const d = deps();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        d.order.push("put");
        return new Response(null, { status: 200 });
      }),
    );

    await expect(uploadBlogCover(d, { postId: POST_ID, file: file("image/webp") })).resolves.toEqual({
      ok: true,
    });
    expect(d.order).toEqual(["sign", "put", "attach"]);
    expect(d.attach).toHaveBeenCalledWith(POST_ID, KEY);
  });

  it("refuses a non-image (and SVG) before asking for a URL", async () => {
    const d = deps();

    await expect(uploadBlogCover(d, { postId: POST_ID, file: file("image/svg+xml") })).resolves.toEqual({
      ok: false,
      reason: "notAnImage",
    });
    expect(d.requestUpload).not.toHaveBeenCalled();
  });

  it("refuses an oversized file", async () => {
    await expect(
      uploadBlogCover(deps(), { postId: POST_ID, file: file("image/png", 16 * 1024 * 1024) }),
    ).resolves.toEqual({ ok: false, reason: "tooLarge" });
  });

  it("does not record the key when the PUT fails", async () => {
    const d = deps();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));

    await expect(uploadBlogCover(d, { postId: POST_ID, file: file("image/png") })).resolves.toEqual({
      ok: false,
      reason: "uploadFailed",
    });
    expect(d.attach).not.toHaveBeenCalled();
  });

  it("maps a signing failure and an attach failure to their own reasons", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const unsigned = deps({
      requestUpload: vi.fn(async () => ({ ok: false as const, code: null, reason: null, message: "x" })),
    });
    const unattached = deps({
      attach: vi.fn(async () => ({ ok: false as const, code: null, reason: null, message: "x" })),
    });

    await expect(uploadBlogCover(unsigned, { postId: POST_ID, file: file("image/png") })).resolves.toEqual({
      ok: false,
      reason: "signFailed",
    });
    await expect(uploadBlogCover(unattached, { postId: POST_ID, file: file("image/png") })).resolves.toEqual({
      ok: false,
      reason: "attachFailed",
    });
  });
});
