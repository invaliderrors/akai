import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { Product } from "@akai/contracts";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { AdjustStockDialog } from "@/components/admin/adjust-stock-dialog";
import { ProductDangerZone, ProductEditor } from "@/components/admin/product-editor";
import { LiveProductMedia } from "@/components/admin/product-media";
import { SectionHeader } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { Notice } from "@/components/ui/notice";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type Column } from "@/components/ui/table";
import { PageTemplate } from "@/components/shell/page-template";
import {
  addProductMediaAction,
  createMediaUploadUrlAction,
  removeProductMediaAction,
} from "@/lib/admin/actions";
import { loadAddOnCandidates } from "@/lib/admin/add-on-candidates";
import { loadPackComponentCandidates } from "@/lib/admin/pack-component-candidates";
import { getProduct, listCategories } from "@/lib/admin/api";
import { AdminApiError } from "@/lib/admin/http";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { DEFAULT_CURRENCY } from "@/lib/admin/schemas";
import { createServerApiClient } from "@/lib/api/client";

type ProductVariant = Product["variants"][number];

/**
 * Edit one product.
 *
 * THE VARIANT TABLE BELOW THE FORM STAYS READ-ONLY, but no longer because
 * per-variant editing is unbuilt — it now genuinely works, through the form
 * above (`ProductForm`'s own variant section, wired via
 * `classifyVariantChanges` and each row's own `version`, which is exactly the
 * per-row concurrency handling this comment used to say did not exist yet).
 * This table stays purely informational because it, uniquely, also shows
 * `net`/`tax`/`reserved` — figures the form has no input for and has no reason
 * to grow one for, since nothing here writes them directly.
 *
 * THE 404 BRANCH KEYS ON `cause.status`, unlike the discount detail page, which
 * keys on `cause.code === "NOT_FOUND"`. That asymmetry is deliberate and belongs
 * to the endpoints: a missing product is a bare 404 from a REST path with an id
 * in it, which is what a stale link produces, and telling the operator "this
 * product does not exist" is the correct answer to it.
 *
 * THE IMAGES CONTROL IS `MediaUploader` IN LIVE MODE. It replaces the
 * product-only media manager; the same component in staged mode serves the
 * create page, so there is one grid, one alt-text editor and one presign → PUT →
 * attach dance rather than two that had already drifted.
 */
export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const t = await getTranslations("admin.productForm");
  const tProducts = await getTranslations("admin.products");
  const tCommon = await getTranslations("admin.common");

  let product: Awaited<ReturnType<typeof getProduct>>;
  try {
    const http = createAdminHttp(await createServerApiClient());
    product = await getProduct(http, id);
  } catch (cause) {
    // A missing product is a 404, not an error panel — the operator followed a
    // stale link or the product was purged.
    if (cause instanceof AdminApiError && cause.status === 404) {
      notFound();
    }
    return (
      <PageTemplate title={tProducts("title")} width="admin">
        <AdminErrorState cause={cause} title={t("loadErrorTitle")} />
      </PageTemplate>
    );
  }

  // The store's base currency is the one its variants are already priced in.
  // `DEFAULT_CURRENCY` covers a product with no variants yet — see its own note
  // for why the assumption lives in exactly one place.
  const currency = product.variants[0]?.price.currency ?? DEFAULT_CURRENCY;

  // Excludes this product: a page cannot offer itself, and showing it in the
  // list only invites the 400 the service would answer with.
  const addOnCandidates = await loadAddOnCandidates(
    createAdminHttp(await createServerApiClient()),
    product.id,
  );

  // Same exclusion, for the pack-components picker.
  const packComponentCandidates = await loadPackComponentCandidates(
    createAdminHttp(await createServerApiClient()),
    product.id,
  );

  // Degrades to NO PANEL rather than failing the whole page — a category-tree
  // outage should not block editing everything else about a product.
  const categories = await listCategories(createAdminHttp(await createServerApiClient()))
    .then((response) => response.items)
    .catch(() => undefined);

  const variantColumns: readonly Column<ProductVariant>[] = [
    {
      key: "sku",
      header: t("variantColumns.sku"),
      kind: "identifier",
      cell: (variant) => variant.sku,
    },
    {
      key: "price",
      header: t("variantColumns.price"),
      kind: "numeric",
      cell: (variant) => (
        <Money amount={variant.price.gross} currency={variant.price.currency} />
      ),
    },
    // Net and tax are DERIVED server-side by @akai/money's splitGross and
    // constrained by a DB CHECK that net + tax = gross. Shown, never edited.
    {
      key: "net",
      header: t("variantColumns.net"),
      kind: "numeric",
      cell: (variant) => (
        <Money amount={variant.price.net} currency={variant.price.currency} />
      ),
    },
    {
      key: "tax",
      header: t("variantColumns.tax"),
      kind: "numeric",
      cell: (variant) => (
        <Money amount={variant.price.tax} currency={variant.price.currency} />
      ),
    },
    {
      key: "available",
      header: t("variantColumns.available"),
      kind: "numeric",
      // The sellable number, and the one that gets badged at zero. The row RAIL
      // is NOT drawn here: the attention treatment is spent on the two list
      // screens an operator scans, and a third site would dilute it into
      // decoration. The badge alone still names the state.
      cell: (variant) =>
        variant.inventory.available > 0 ? (
          variant.inventory.available
        ) : (
          <StatusBadge
            domain="stock"
            value={variant.inventory.allowBackorder ? "backorder" : "out"}
            density="compact"
          />
        ),
    },
    {
      key: "onHand",
      header: t("variantColumns.onHand"),
      kind: "numeric",
      cell: (variant) => variant.inventory.onHand,
    },
    {
      key: "reserved",
      header: t("variantColumns.reserved"),
      kind: "numeric",
      cell: (variant) => variant.inventory.reserved,
    },
    {
      key: "active",
      header: t("variantColumns.active"),
      cell: (variant) => (variant.isActive ? tCommon("yes") : tCommon("no")),
    },
    {
      key: "version",
      header: t("variantColumns.version"),
      kind: "numeric",
      cell: (variant) => variant.version,
    },
    {
      // The one write on an otherwise read-only table, and it is a dialog rather
      // than an editable cell for the reason stated at the top of this file:
      // every variant carries a `version`, and inline editing would need per-row
      // conflict handling. `adjustInventoryAction` finally has a caller.
      key: "adjust",
      header: t("stock.adjust"),
      kind: "actions",
      headerHidden: true,
      cell: (variant) => (
        <AdjustStockDialog
          variantId={variant.id}
          sku={variant.sku}
          onHand={variant.inventory.onHand}
          reserved={variant.inventory.reserved}
        />
      ),
    },
  ];

  return (
    <PageTemplate
      title={product.name}
      titleAdornment={
        <StatusBadge domain="product" value={product.status} density="compact" />
      }
      description={t("editSubtitle", { slug: product.slug })}
      breadcrumb={{
        label: tProducts("title"),
        links: [{ label: tProducts("title"), href: "/admin/products" }],
      }}
      width="admin"
    >
      <div className="grid gap-4">
        {product.deletedAt !== null && <Notice tone="warning">{t("deletedNotice")}</Notice>}

        <ProductEditor
          product={product}
          currency={currency}
          addOnCandidates={addOnCandidates}
          packComponentCandidates={packComponentCandidates}
          {...(categories === undefined ? {} : { categories })}
          // Built here because it binds server actions to an id that exists.
          // The labels are assembled inside `LiveProductMedia`, which is a
          // client component for a structural reason: three of them are
          // functions, and a function cannot cross this boundary.
          mediaSlot={
            <LiveProductMedia
              productId={product.id}
              items={product.media}
              onRequestUpload={createMediaUploadUrlAction}
              onAttach={addProductMediaAction}
              onRemove={removeProductMediaAction}
            />
          }
        />

        <section aria-labelledby="variants-heading" className="grid gap-2">
          <SectionHeader
            id="variants-heading"
            title={t("variantsTableTitle")}
            density="compact"
          />
          <DataTable
            caption={t("variantsTableTitle")}
            columns={variantColumns}
            rows={product.variants}
            rowKey={(variant) => variant.id}
            minWidth="wide"
          />
          <p className="m-0 text-[11px] leading-4 text-[var(--label-secondary)]">
            {t("variantsTableHint")}
          </p>
        </section>

        <ProductDangerZone productId={product.id} productSlug={product.slug} />
      </div>
    </PageTemplate>
  );
}

export const dynamic = "force-dynamic";
