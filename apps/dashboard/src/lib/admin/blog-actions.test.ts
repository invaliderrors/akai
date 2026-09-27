import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminHttpRequest, AdminHttpResponse } from "./http";

/**
 * The blog server actions (spec 2026-09-24 §8).
 *
 * Same harness as `actions.test.ts`: the admin HTTP port is faked at the
 * adapter, so what is asserted is exactly the request each action forwards —
 * its path, its re-validated body — and the paths it revalidates.
 */

const calls: AdminHttpRequest[] = [];
let respond: (input: AdminHttpRequest) => AdminHttpResponse = () => ({ status: 200, body: {} });

const revalidatePath = vi.fn<(path: string) => void>();

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("../api/client", () => ({
  apiBaseUrl: () => "http://api.test",
  createApiClient: () => ({}),
}));
vi.mock("../session/server", () => ({
  getSession: async () => null,
  writeSession: async () => undefined,
  clearSession: async () => undefined,
}));
vi.mock("../api/auth", () => ({ refresh: vi.fn() }));
vi.mock("./http-adapter", () => ({
  createAdminHttp: () => ({
    async request(input: AdminHttpRequest): Promise<AdminHttpResponse> {
      calls.push(input);
      return respond(input);
    },
  }),
}));

const {
  createBlogCoverUploadUrlAction,
  createBlogPostAction,
  deleteBlogPostAction,
  setBlogPostPublishedAction,
  translateBlogCopyAction,
  updateBlogPostAction,
} = await import("./actions");

const POST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ISO = "2026-09-24T10:00:00.000Z";

function adminPost(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    slug: "que-es-bpc-157",
    status: "DRAFT",
    category: "PEPTIDES",
    publishedAt: null,
    coverObjectKey: null,
    coverUrl: null,
    authorId: null,
    createdAt: ISO,
    updatedAt: ISO,
    translations: [
      {
        locale: "es",
        title: "Título",
        excerpt: "Resumen",
        bodyHtml: "<p>Hola</p>",
        metaTitle: null,
        metaDescription: null,
        coverAlt: "",
      },
    ],
    ...overrides,
  };
}

const CREATE = {
  slug: "que-es-bpc-157",
  category: "PEPTIDES" as const,
  translations: [
    {
      locale: "es" as const,
      title: "Título",
      excerpt: "Resumen",
      bodyHtml: "<p>Hola</p>",
      metaTitle: null,
      metaDescription: null,
      coverAlt: "",
    },
  ],
};

beforeEach(() => {
  calls.length = 0;
  revalidatePath.mockReset();
  respond = () => ({ status: 200, body: adminPost() });
});

describe("blog actions", () => {
  it("creates a draft and hands back its id", async () => {
    respond = () => ({ status: 201, body: adminPost() });

    const result = await createBlogPostAction(CREATE);

    expect(result).toEqual({ ok: true, data: { id: POST_ID } });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/admin/blog/posts", body: CREATE });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/blog");
  });

  it("re-validates its input — a server action is a public endpoint", async () => {
    const result = await createBlogPostAction({ ...CREATE, slug: "Not A Slug" });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a duplicate slug as the CONFLICT code, never the server's English", async () => {
    respond = () => ({
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message: "A blog post with this slug already exists",
          requestId: "req_1",
          timestamp: ISO,
        },
      },
    });

    const result = await createBlogPostAction(CREATE);

    expect(result).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("patches a post and revalidates both the list and the post", async () => {
    await updateBlogPostAction(POST_ID, { coverObjectKey: null });

    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: `/admin/blog/posts/${POST_ID}`,
      body: { coverObjectKey: null },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/blog/${POST_ID}`);
  });

  it("publishes and unpublishes through the two verbs", async () => {
    respond = () => ({ status: 201, body: adminPost({ status: "PUBLISHED", publishedAt: ISO }) });
    await expect(setBlogPostPublishedAction(POST_ID, true)).resolves.toEqual({
      ok: true,
      data: { status: "PUBLISHED" },
    });
    respond = () => ({ status: 201, body: adminPost() });
    await setBlogPostPublishedAction(POST_ID, false);

    expect(calls.map((call) => call.path)).toEqual([
      `/admin/blog/posts/${POST_ID}/publish`,
      `/admin/blog/posts/${POST_ID}/unpublish`,
    ]);
  });

  it("deletes, and reports a refused delete as a failure", async () => {
    respond = () => ({ status: 204, body: null });
    await expect(deleteBlogPostAction(POST_ID)).resolves.toEqual({ ok: true, data: null });

    respond = () => ({
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "no", requestId: "r", timestamp: ISO } },
    });
    await expect(deleteBlogPostAction(POST_ID)).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("asks for a cover upload URL scoped to the post", async () => {
    respond = () => ({
      status: 200,
      body: {
        uploadUrl: "http://s3.test/put",
        objectKey: `blog/${POST_ID}/a.webp`,
        publicUrl: "http://s3.test/a.webp",
        expiresInSeconds: 600,
      },
    });

    const result = await createBlogCoverUploadUrlAction(POST_ID, {
      contentType: "image/webp",
      sizeBytes: 1000,
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.path).toBe(`/admin/blog/posts/${POST_ID}/cover/upload-url`);
  });
});

describe("translateBlogCopyAction", () => {
  const copy = {
    title: "Qué es BPC-157",
    excerpt: "Resumen",
    bodyHtml: "<p>Hola</p>",
    metaTitle: "",
    metaDescription: "",
    coverAlt: "",
  };

  it("sends only the non-blank fields, keyed, and merges the answer back", async () => {
    respond = () => ({
      status: 200,
      body: {
        translations: [
          { key: "title", text: "What is BPC-157" },
          { key: "excerpt", text: "Summary" },
          { key: "bodyHtml", text: "<p>Hello</p>" },
        ],
      },
    });

    const result = await translateBlogCopyAction({ from: "es", to: "en", copy });

    expect(calls[0]).toMatchObject({
      path: "/admin/translations",
      body: {
        source: "es",
        target: "en",
        texts: [
          { key: "title", text: "Qué es BPC-157" },
          { key: "excerpt", text: "Resumen" },
          { key: "bodyHtml", text: "<p>Hola</p>" },
        ],
      },
    });
    expect(result).toEqual({
      ok: true,
      data: { ...copy, title: "What is BPC-157", excerpt: "Summary", bodyHtml: "<p>Hello</p>" },
    });
  });

  it("answers an all-blank source without spending a request", async () => {
    const blank = { ...copy, title: "", excerpt: "", bodyHtml: "" };

    const result = await translateBlogCopyAction({ from: "es", to: "en", copy: blank });

    expect(result).toMatchObject({ ok: false, reason: "EMPTY_SOURCE" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a same-locale request and a malformed one before the vendor", async () => {
    await expect(translateBlogCopyAction({ from: "es", to: "es", copy })).resolves.toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
    });
    await expect(translateBlogCopyAction({ from: "es", to: "en" })).resolves.toMatchObject({
      ok: false,
    });
    expect(calls).toHaveLength(0);
  });
});
