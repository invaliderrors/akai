import { getTranslations } from "next-intl/server";

import { BlogPostEditor } from "@/components/admin/blog-post-editor";
import { PageTemplate } from "@/components/shell/page-template";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import Link from "next/link";

/** A new post is always a draft; publishing is its own step on the edit page. */
export default async function NewBlogPostPage() {
  const t = await getTranslations("admin.blog");

  return (
    <PageTemplate
      title={t("newTitle")}
      description={t("newDescription")}
      width="admin"
      actions={
        <Link href="/admin/blog" className={buttonClassName({ variant: "standard" })}>
          {t("back")}
        </Link>
      }
    >
      <Card>
        <BlogPostEditor />
      </Card>
    </PageTemplate>
  );
}

export const dynamic = "force-dynamic";
