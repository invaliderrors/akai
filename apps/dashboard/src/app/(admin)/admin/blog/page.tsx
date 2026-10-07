import { getTranslations } from "next-intl/server";
import type { AdminBlogPost } from "@akai/contracts";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { BlogDeleteButton } from "@/components/admin/blog-delete-button";
import { BlogPublishSwitch } from "@/components/admin/blog-publish-switch";
import { PageTemplate } from "@/components/shell/page-template";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { activeCursor, CursorPagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { DataTable, type Column } from "@/components/ui/table";
import Link from "next/link";
import { listBlogPosts } from "@/lib/admin/api";
import { formatDate } from "@/lib/admin/discount-display";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { createServerApiClient } from "@/lib/api/client";

/**
 * The blog's posts — spec 2026-09-24 §8.
 *
 * Every post, drafts included, newest first. Status is a badge AND a switch:
 * the badge is what scans down a column, the switch is the one-flip publish /
 * unpublish. Delete asks first, naming the post.
 */
export const dynamic = "force-dynamic";

const PATHNAME = "/admin/blog";
const PAGE_SIZE = 25;
const NO_VALUE = "—";

export default async function AdminBlogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const t = await getTranslations("admin.blog");
  const tUi = await getTranslations("ui");
  const cursor = activeCursor(query["cursor"]);

  const http = createAdminHttp(await createServerApiClient());

  let page: Awaited<ReturnType<typeof listBlogPosts>>;
  try {
    page = await listBlogPosts(http, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: PAGE_SIZE,
    });
  } catch (cause) {
    return (
      <PageTemplate title={t("title")} description={t("description")} width="admin">
        <AdminErrorState cause={cause} title={t("loadErrorTitle")} />
      </PageTemplate>
    );
  }

  const columns: readonly Column<AdminBlogPost>[] = [
    {
      key: "title",
      header: t("colTitle"),
      kind: "identifier",
      cell: (post) => (
        <Link href={`${PATHNAME}/${post.id}`} aria-label={t("viewRow", { title: post.title })}>
          {post.title}
        </Link>
      ),
    },
    { key: "slug", header: t("colSlug"), cell: (post) => post.slug },
    { key: "category", header: t("colCategory"), cell: (post) => t(`categories.${post.category}`) },
    {
      key: "status",
      header: t("colStatus"),
      cell: (post) =>
        post.status === "PUBLISHED" ? (
          <Badge tone="success" density="compact" label={t("status.PUBLISHED")} />
        ) : (
          <Badge tone="neutral" density="compact" label={t("status.DRAFT")} />
        ),
    },
    {
      key: "publishedAt",
      header: t("colPublishedAt"),
      cell: (post) => (post.publishedAt === null ? NO_VALUE : formatDate(post.publishedAt)),
    },
    {
      key: "actions",
      header: t("colActions"),
      cell: (post) => (
        <div className="flex items-center gap-2">
          <BlogPublishSwitch postId={post.id} status={post.status} title={post.title} labelHidden />
          <BlogDeleteButton postId={post.id} title={post.title} />
        </div>
      ),
    },
  ];

  return (
    <PageTemplate
      title={t("title")}
      description={t("description")}
      width="admin"
      actions={
        <Link
          href="/admin/blog/new"
          className={buttonClassName({ variant: "prominent", size: "compact", leadingIcon: true })}
        >
          <Icon name="plus" size={14} />
          {t("new")}
        </Link>
      }
    >
      <DataTable
        caption={t("title")}
        columns={columns}
        rows={page.items}
        rowKey={(post) => post.id}
        minWidth="wide"
        empty={
          <EmptyState
            title={t("emptyTitle")}
            body={t("emptyBody")}
            reason="nothing-yet"
            density="table"
          />
        }
        footer={
          page.items.length === 0 ? null : (
            <CursorPagination
              labels={{
                nav: tUi("pagination"),
                first: tUi("first"),
                previous: tUi("previous"),
                next: tUi("next"),
                page: (value: number) => tUi("page", { page: value }),
                perPage: tUi("perPage"),
                showing: ({ from, to, hasMore }) =>
                  hasMore ? tUi("showingMore", { from, to }) : tUi("showing", { from, to }),
              }}
              pathname={PATHNAME}
              searchParams={query}
              itemCount={page.items.length}
              pageSize={PAGE_SIZE}
              hasMore={page.hasMore}
              nextCursor={page.nextCursor}
            />
          )
        }
      />
    </PageTemplate>
  );
}
