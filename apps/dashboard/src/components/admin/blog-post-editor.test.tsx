import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { adminBlogPostSchema, type AdminBlogPost } from "@akai/contracts";

import type { ActionResult } from "@/lib/admin/actions";
import { EMPTY_BLOG_COPY, type BlogCopy } from "@/lib/admin/blog-copy";
import esMessages from "../../../messages/es.json";
import enMessages from "../../../messages/en.json";

const createBlogPostAction = vi.fn<(input: unknown) => Promise<ActionResult<{ id: string }>>>();
const updateBlogPostAction =
  vi.fn<(id: string, input: unknown) => Promise<ActionResult<{ id: string }>>>();
const deleteBlogPostAction = vi.fn<(id: string) => Promise<ActionResult<null>>>();
const translateBlogCopyAction = vi.fn<(input: unknown) => Promise<ActionResult<BlogCopy>>>();

const push = vi.fn<(href: string) => void>();
const refresh = vi.fn<() => void>();

vi.mock("@/lib/admin/actions", () => ({
  createBlogPostAction: (input: unknown) => createBlogPostAction(input),
  updateBlogPostAction: (id: string, input: unknown) => updateBlogPostAction(id, input),
  deleteBlogPostAction: (id: string) => deleteBlogPostAction(id),
  translateBlogCopyAction: (input: unknown) => translateBlogCopyAction(input),
  createBlogCoverUploadUrlAction: vi.fn(),
  setBlogPostPublishedAction: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const { BlogPostEditor, buildBlogPostPayload, toBlogFormValues } = await import("./blog-post-editor");

const POST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ISO = "2026-09-24T10:00:00.000Z";
const blog = esMessages.admin.blog;

function buildPost(overrides: Record<string, unknown> = {}): AdminBlogPost {
  return adminBlogPostSchema.parse({
    id: POST_ID,
    slug: "que-es-bpc-157",
    status: "DRAFT",
    category: "NEWS",
    publishedAt: null,
    coverObjectKey: null,
    coverUrl: null,
    authorId: null,
    createdAt: ISO,
    updatedAt: ISO,
    translations: [
      {
        locale: "es",
        title: "Qué es BPC-157",
        excerpt: "Resumen",
        bodyHtml: "<p>Hola</p>",
        metaTitle: null,
        metaDescription: null,
        coverAlt: "",
      },
    ],
    ...overrides,
  });
}

function renderEditor(post?: AdminBlogPost) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <BlogPostEditor {...(post === undefined ? {} : { post })} />
    </NextIntlClientProvider>,
  );
}

function field(name: string): HTMLElement {
  const element = document.querySelector(`[name="${name}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no field ${name}`);
  return element;
}

beforeEach(() => {
  createBlogPostAction.mockReset();
  updateBlogPostAction.mockReset();
  deleteBlogPostAction.mockReset();
  translateBlogCopyAction.mockReset();
  push.mockReset();
  refresh.mockReset();
});

describe("buildBlogPostPayload", () => {
  const values = {
    slug: "que-es-bpc-157",
    category: "PEPTIDES" as const,
    includeEnglish: false,
    copy: {
      es: { ...EMPTY_BLOG_COPY, title: " Título ", excerpt: "Resumen", bodyHtml: "<p>x</p>" },
      en: EMPTY_BLOG_COPY,
    },
  };

  it("builds a Spanish-only create, trimming and nulling blank meta (D8c)", () => {
    const built = buildBlogPostPayload(values, "create");

    expect(built).toEqual({
      ok: true,
      mode: "create",
      value: {
        slug: "que-es-bpc-157",
        category: "PEPTIDES",
        translations: [
          {
            locale: "es",
            title: "Título",
            excerpt: "Resumen",
            bodyHtml: "<p>x</p>",
            metaTitle: null,
            metaDescription: null,
            coverAlt: "",
          },
        ],
      },
    });
  });

  it("requires every English field once English is included", () => {
    const built = buildBlogPostPayload({ ...values, includeEnglish: true }, "create");

    expect(built).toEqual({
      ok: false,
      errors: { "en.title": "REQUIRED", "en.excerpt": "REQUIRED", "en.bodyHtml": "REQUIRED" },
    });
  });

  it("flags a missing or malformed slug and a missing Spanish body", () => {
    expect(buildBlogPostPayload({ ...values, slug: "" }, "create")).toMatchObject({
      ok: false,
      errors: { slug: "REQUIRED" },
    });
    expect(buildBlogPostPayload({ ...values, slug: "Con Espacios" }, "edit")).toMatchObject({
      ok: false,
      errors: { slug: "INVALID_SLUG" },
    });
    expect(
      buildBlogPostPayload(
        { ...values, copy: { ...values.copy, es: { ...values.copy.es, bodyHtml: "  " } } },
        "edit",
      ),
    ).toMatchObject({ ok: false, errors: { "es.bodyHtml": "REQUIRED" } });
  });

  it("seeds English as included only when the post has an English row", () => {
    expect(toBlogFormValues(buildPost()).includeEnglish).toBe(false);
    expect(toBlogFormValues(undefined).includeEnglish).toBe(false);
  });
});

describe("<BlogPostEditor /> — create", () => {
  it("creates a draft and navigates to its edit page", async () => {
    createBlogPostAction.mockResolvedValue({ ok: true, data: { id: POST_ID } });
    const user = userEvent.setup();
    renderEditor();

    expect(screen.getByText(blog.form.coverAfterCreate)).toBeInTheDocument();
    await user.type(field("slug"), "que-es-bpc-157");
    await user.type(field("es-title"), "Título");
    await user.type(field("es-excerpt"), "Resumen");
    await user.type(field("es-body"), "Hola");
    await user.click(screen.getByRole("button", { name: blog.form.submitCreate }));

    expect(createBlogPostAction).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "que-es-bpc-157", category: "PEPTIDES" }),
    );
    expect(push).toHaveBeenCalledWith(`/admin/blog/${POST_ID}`);
  });

  it("does not send an invalid form, and says what to fix", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("button", { name: blog.form.submitCreate }));

    expect(createBlogPostAction).not.toHaveBeenCalled();
    expect(screen.getByText(blog.form.fixErrors)).toBeInTheDocument();
  });

  it("renders a duplicate slug as translated copy, not the API's English", async () => {
    createBlogPostAction.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      reason: null,
      message: "A blog post with this slug already exists",
    });
    const user = userEvent.setup();
    renderEditor();

    await user.type(field("slug"), "repetido");
    await user.type(field("es-title"), "T");
    await user.type(field("es-excerpt"), "E");
    await user.type(field("es-body"), "B");
    await user.click(screen.getByRole("button", { name: blog.form.submitCreate }));

    expect(await screen.findByText(blog.errors.CONFLICT)).toBeInTheDocument();
    expect(screen.queryByText("A blog post with this slug already exists")).toBeNull();
  });

  it("previews the body through the sanitiser", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(field("es-body"), "<h2>Hola</h2>");

    const preview = screen.getByRole("region", { name: blog.form.previewLabel });
    expect(within(preview).getByRole("heading", { name: "Hola" })).toBeInTheDocument();
  });
});

describe("<BlogPostEditor /> — English and translation", () => {
  it("shows the English section only when opted in", async () => {
    const user = userEvent.setup();
    renderEditor(buildPost());

    expect(screen.queryByTestId("blog-locale-en")).toBeNull();
    await user.click(screen.getByLabelText(blog.form.includeEnglish));
    expect(screen.getByTestId("blog-locale-en")).toBeInTheDocument();
  });

  it("prefills English from Spanish, flags it as machine-translated, and never saves", async () => {
    translateBlogCopyAction.mockResolvedValue({
      ok: true,
      data: { ...EMPTY_BLOG_COPY, title: "What is BPC-157", excerpt: "Summary", bodyHtml: "<p>Hi</p>" },
    });
    const user = userEvent.setup();
    renderEditor(buildPost());

    await user.click(screen.getByLabelText(blog.form.includeEnglish));
    const english = within(screen.getByTestId("blog-locale-en"));
    await user.click(english.getByRole("button", { name: "Traducir desde español" }));

    expect(translateBlogCopyAction).toHaveBeenCalledWith(
      expect.objectContaining({ from: "es", to: "en" }),
    );
    expect(field("en-title")).toHaveValue("What is BPC-157");
    expect(english.getByText(blog.machineTranslated)).toBeInTheDocument();
    expect(updateBlogPostAction).not.toHaveBeenCalled();
  });

  it("explains a translation failure by its reason, in the operator's language", async () => {
    translateBlogCopyAction.mockResolvedValue({
      ok: false,
      code: "VALIDATION_FAILED",
      reason: "NOT_CONFIGURED",
      message: "DeepL is not configured",
    });
    const user = userEvent.setup();
    renderEditor(buildPost());

    await user.click(screen.getByLabelText(blog.form.includeEnglish));
    await user.click(screen.getByRole("button", { name: "Traducir desde español" }));

    expect(await screen.findByText(blog.translateErrors.NOT_CONFIGURED)).toBeInTheDocument();
  });

  it("saves an edit with the English row included", async () => {
    updateBlogPostAction.mockResolvedValue({ ok: true, data: { id: POST_ID } });
    const user = userEvent.setup();
    renderEditor(buildPost());

    await user.click(screen.getByLabelText(blog.form.includeEnglish));
    await user.type(field("en-title"), "Title");
    await user.type(field("en-excerpt"), "Summary");
    await user.type(field("en-body"), "Body");
    await user.click(screen.getByRole("button", { name: blog.form.submitSave }));

    const [, input] = updateBlogPostAction.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      translations: [{ locale: "es" }, { locale: "en", title: "Title" }],
    });
    expect(refresh).toHaveBeenCalled();
  });
});

describe("messages", () => {
  it("labels every blog category in both dashboards languages (D8b)", () => {
    expect(esMessages.admin.blog.categories).toEqual({
      PEPTIDES: "Péptidos",
      RESEARCH_GUIDES: "Guías de investigación",
      NEWS: "Noticias",
    });
    expect(enMessages.admin.blog.categories).toEqual({
      PEPTIDES: "Peptides",
      RESEARCH_GUIDES: "Research guides",
      NEWS: "News",
    });
  });
});
