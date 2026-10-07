import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { BlogPostEditor } from "@/components/admin/blog-post-editor";
import { BlogPublishSwitch } from "@/components/admin/blog-publish-switch";
import { PageTemplate } from "@/components/shell/page-template";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import Link from "next/link";
import { getBlogPost } from "@/lib/admin/api";
import { AdminApiError } from "@/lib/admin/http";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { createServerApiClient } from "@/lib/api/client";

export default async function EditBlogPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("admin.blog");
  const http = createAdminHttp(await createServerApiClient());

  let post: Awaited<ReturnType<typeof getBlogPost>>;
  try {
    post = await getBlogPost(http, id);
  } catch (cause) {
    if (cause instanceof AdminApiError && cause.code === "NOT_FOUND") {
      notFound();
    }
    return (
      <PageTemplate title={t("title")} width="admin">
        <AdminErrorState cause={cause} title={t("detailErrorTitle")} />
      </PageTemplate>
    );
  }

  return (
    <PageTemplate
      title={post.title}
      description={t("editDescription")}
      width="admin"
      titleAdornment={
        post.status === "PUBLISHED" ? (
          <Badge tone="success" density="compact" label={t("status.PUBLISHED")} />
        ) : (
          <Badge tone="neutral" density="compact" label={t("status.DRAFT")} />
        )
      }
      actions={
        <Link href="/admin/blog" className={buttonClassName({ variant: "standard" })}>
          {t("back")}
        </Link>
      }
    >
      <div className="grid gap-4">
        <Card>
          <BlogPublishSwitch postId={post.id} status={post.status} title={post.title} />
        </Card>
        <Card>
          {/* Keyed on `updatedAt` so a save or a cover upload that refreshes
              the page re-seeds the form from what the server now holds. */}
          <BlogPostEditor key={post.updatedAt} post={post} />
        </Card>
      </div>
    </PageTemplate>
  );
}

export const dynamic = "force-dynamic";
