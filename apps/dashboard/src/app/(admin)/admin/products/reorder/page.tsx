import { getTranslations } from "next-intl/server";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import {
  ProductReorderList,
  type ProductReorderRow,
} from "@/components/admin/product-reorder-list";
import { PageTemplate } from "@/components/shell/page-template";
import { createServerApiClient } from "@/lib/api/client";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { listProducts } from "@/lib/admin/api";
import { reorderProductsAction } from "@/lib/admin/actions";

/**
 * The catalogue-wide manual order — one screen, the WHOLE catalogue.
 *
 * `limit: CATALOGUE_CEILING` asks for the API's own maximum in ONE request
 * rather than paging: the reorder tool loses its entire point the moment it
 * only shows one cursor-paginated page, since an operator could never move
 * product 40 next to product 2. `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`
 * §8 records why this is safe — this store's real catalogue sits comfortably
 * inside 100 rows; a catalogue that outgrows this ceiling needs a different
 * tool, not a bigger number here.
 *
 * `sort: "manual"` so the list an operator sees on load IS the order the
 * storefront is already using — reordering from a page sorted some other way
 * would make "move this to the top" lie about what changed.
 */
const CATALOGUE_CEILING = 100;

export default async function ProductReorderPage() {
  const t = await getTranslations("admin.productReorder");

  const http = createAdminHttp(await createServerApiClient());

  let rows: readonly ProductReorderRow[] = [];
  let loadError: unknown = null;
  try {
    const page = await listProducts(http, { sort: "manual", limit: CATALOGUE_CEILING });
    rows = page.items.map((product) => ({
      id: product.id,
      name: product.name,
      sku: product.variants[0]?.sku ?? "",
      imageUrl: product.media[0]?.url ?? null,
    }));
  } catch (error: unknown) {
    loadError = error;
  }

  return (
    <PageTemplate width="admin" title={t("title")} description={t("description")}>
      {loadError !== null ? (
        <AdminErrorState cause={loadError} title={t("loadErrorTitle")} />
      ) : (
        <ProductReorderList initial={rows} onSave={reorderProductsAction} />
      )}
    </PageTemplate>
  );
}
