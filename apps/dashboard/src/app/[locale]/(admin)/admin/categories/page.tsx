import { getTranslations } from "next-intl/server";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { CategoryManager, type CategoryRow } from "@/components/admin/category-manager";
import { PageTemplate } from "@/components/shell/page-template";
import { createServerApiClient } from "@/lib/api/client";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { listCategories } from "@/lib/admin/api";
import {
  createCategoryAction,
  deleteCategoryAction,
  reorderCategoriesAction,
  updateCategoryAction,
} from "@/lib/admin/actions";

/**
 * The catalogue's category tree.
 *
 * §6 of `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`
 * reopens the 2026-09-12 decision ("one-time seed-script edit is sufficient")
 * — this screen supersedes it with a real admin surface, and its own
 * `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md` §6 notes
 * that a categories screen is of limited use unless per-product category
 * assignment also works, which `product-form.tsx`'s `categoryIds` fix (same
 * change) addresses.
 *
 * `GET /admin/categories` mirrors the public `GET /v1/categories` behind
 * auth, so this reads the identical list a shopper's nav does — not a
 * separately-derived one.
 */
export default async function AdminCategoriesPage() {
  const t = await getTranslations("admin.categoryManager");
  const http = createAdminHttp(await createServerApiClient());

  let rows: readonly CategoryRow[] = [];
  let loadError: unknown = null;
  try {
    const { items } = await listCategories(http);
    rows = items.map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      productCount: category.productCount,
    }));
  } catch (error: unknown) {
    loadError = error;
  }

  return (
    <PageTemplate width="admin" title={t("title")} description={t("description")}>
      {loadError !== null ? (
        <AdminErrorState cause={loadError} title={t("loadErrorTitle")} />
      ) : (
        <CategoryManager
          initial={rows}
          onCreate={createCategoryAction}
          onRename={updateCategoryAction}
          onReorder={reorderCategoriesAction}
          onDelete={deleteCategoryAction}
        />
      )}
    </PageTemplate>
  );
}
