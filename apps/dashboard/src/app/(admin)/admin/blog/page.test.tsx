import type { ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminBlogPostSchema, type AdminBlogPost } from "@akai/contracts";

import type { ActionResult } from "@/lib/admin/actions";
import esMessages from "../../../../../messages/es.json";

/**
 * The blog list: every post with its status, a publish switch and a delete
 * that names the post before it acts.
 */

const listBlogPosts = vi.fn<(http: unknown, params: unknown) => Promise<unknown>>();
const setBlogPostPublishedAction =
  vi.fn<(id: string, published: boolean) => Promise<ActionResult<{ status: string }>>>();
const deleteBlogPostAction = vi.fn<(id: string) => Promise<ActionResult<null>>>();
const refresh = vi.fn<() => void>();

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => {
    const { createTranslator } = await import("next-intl");
    const messages: Record<string, unknown> = esMessages;
    return namespace === undefined
      ? createTranslator({ locale: "es", messages })
      : createTranslator({ locale: "es", messages, namespace });
  },
}));

vi.mock("@/lib/api/client", () => ({ createServerApiClient: async () => ({}) }));
vi.mock("@/lib/admin/http-adapter", () => ({ createAdminHttp: () => ({}) }));
vi.mock("@/lib/admin/api", () => ({
  listBlogPosts: (http: unknown, params: unknown) => listBlogPosts(http, params),
}));
vi.mock("@/lib/admin/actions", () => ({
  setBlogPostPublishedAction: (id: string, published: boolean) =>
    setBlogPostPublishedAction(id, published),
  deleteBlogPostAction: (id: string) => deleteBlogPostAction(id),
}));
vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

const { default: AdminBlogPage } = await import("./page");

const ISO = "2026-09-24T10:00:00.000Z";
const blog = esMessages.admin.blog;

function post(overrides: Record<string, unknown> = {}): AdminBlogPost {
  return adminBlogPostSchema.parse({
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    slug: "como-combinar-un-oversize",
    status: "PUBLISHED",
    category: "STYLE_GUIDES",
    publishedAt: ISO,
    coverObjectKey: null,
    coverUrl: null,
    authorId: null,
    createdAt: ISO,
    updatedAt: ISO,
    title: "Qué es Hoodie Kumo",
    excerpt: "Resumen",
    bodyHtml: "<p>x</p>",
    metaTitle: null,
    metaDescription: null,
    coverAlt: "",
    ...overrides,
  });
}

async function renderPage(query: Record<string, string | string[] | undefined> = {}) {
  const ui = await AdminBlogPage({
    searchParams: Promise.resolve(query),
  });
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  listBlogPosts.mockReset();
  setBlogPostPublishedAction.mockReset();
  deleteBlogPostAction.mockReset();
  refresh.mockReset();
});

describe("AdminBlogPage", () => {
  it("lists drafts and published posts with their status and category", async () => {
    listBlogPosts.mockResolvedValue({
      items: [
        post(),
        post({
          id: "8d9e6679-7425-40de-944b-e07fc1f90ae8",
          slug: "borrador",
          status: "DRAFT",
          publishedAt: null,
          category: "NEWS",
          title: "Novedades de septiembre",
    excerpt: "Resumen",
    bodyHtml: "<p>x</p>",
    metaTitle: null,
    metaDescription: null,
    coverAlt: "",
        }),
      ],
      nextCursor: null,
      hasMore: false,
    });

    await renderPage();

    const table = within(screen.getByRole("table"));
    expect(table.getByText(blog.status.PUBLISHED)).toBeInTheDocument();
    expect(table.getByText(blog.status.DRAFT)).toBeInTheDocument();
    expect(table.getByText(blog.categories.NEWS)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Editar el artículo Qué es Hoodie Kumo" }),
    ).toHaveAttribute("href", "/admin/blog/7c9e6679-7425-40de-944b-e07fc1f90ae7");
  });

  it("links to the create page", async () => {
    listBlogPosts.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });

    await renderPage();

    expect(screen.getByRole("link", { name: blog.new })).toHaveAttribute("href", "/admin/blog/new");
    expect(screen.getByText(blog.emptyTitle)).toBeInTheDocument();
  });

  it("unpublishes with one flip of the row's switch", async () => {
    listBlogPosts.mockResolvedValue({ items: [post()], nextCursor: null, hasMore: false });
    setBlogPostPublishedAction.mockResolvedValue({ ok: true, data: { status: "DRAFT" } });
    const user = userEvent.setup();

    await renderPage();
    const toggle = screen.getByRole("switch", { name: "Publicar «Qué es Hoodie Kumo»" });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(setBlogPostPublishedAction).toHaveBeenCalledWith(
      "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      false,
    );
  });

  it("asks before deleting, naming the post, and deletes only on confirm", async () => {
    listBlogPosts.mockResolvedValue({ items: [post()], nextCursor: null, hasMore: false });
    deleteBlogPostAction.mockResolvedValue({ ok: true, data: null });
    const user = userEvent.setup();

    await renderPage();
    await user.click(screen.getByRole("button", { name: blog.delete.rowTrigger }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Qué es Hoodie Kumo")).toBeInTheDocument();
    expect(deleteBlogPostAction).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: blog.delete.confirm }));

    expect(deleteBlogPostAction).toHaveBeenCalledWith("7c9e6679-7425-40de-944b-e07fc1f90ae7");
    expect(refresh).toHaveBeenCalled();
  });

  it("renders the admin error state when the list cannot load", async () => {
    listBlogPosts.mockRejectedValue(new Error("down"));

    await renderPage();

    expect(screen.getByText(blog.loadErrorTitle)).toBeInTheDocument();
  });
});
