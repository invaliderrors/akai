import { getTranslations } from "next-intl/server";

import { ProductEditor } from "@/components/admin/product-editor";
import { PageTemplate } from "@/components/shell/page-template";
import { loadAddOnCandidates } from "@/lib/admin/add-on-candidates";
import { loadPackComponentCandidates } from "@/lib/admin/pack-component-candidates";
import { listCategories } from "@/lib/admin/api";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { DEFAULT_CURRENCY } from "@/lib/admin/schemas";
import { createServerApiClient } from "@/lib/api/client";

/**
 * Create a product.
 *
 * A new product is always created as a DRAFT and published as a separate,
 * explicit step. The API enforces this too (publish requires at least one active
 * variant and at least one translation), so the two-step flow is not a UI
 * preference — it is what stops a half-entered product appearing in the
 * storefront the instant someone hits save.
 *
 * THE STORE'S BASE CURRENCY comes from `DEFAULT_CURRENCY`, which is where the
 * assumption and its TODO now live in exactly ONE place: that constant's own
 * note says it belongs in a settings endpoint, and it named this page's former
 * `"EUR" as CurrencyCode` cast as the last duplicate of it. EUR is correct for
 * every current market; a wrong assumption threaded through the form in two
 * spellings would not be.
 *
 * `?kind=PACK` PRE-SELECTS THE PACK KIND, so the "New pack" link on
 * `/admin/products/packs` lands an operator on a form that already reads
 * "Pack" rather than making them find the selector themselves. Any other
 * value — including absent — leaves the form's own SIMPLE default alone.
 */
export default async function NewProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const query = await searchParams;
  const locale = rawLocale === "en" ? "en" : "es";
  const initialKind = query["kind"] === "PACK" ? "PACK" : undefined;

  const t = await getTranslations("admin.productForm");

  // The add-on choices. `loadAddOnCandidates` never throws — this page had no
  // failure mode before the picker, and a picker is not worth giving it one: an
  // API blip should leave an operator able to write a product, not staring at an
  // error where the form should be.
  const addOnCandidates = await loadAddOnCandidates(
    createAdminHttp(await createServerApiClient()),
    locale,
  );

  // Same never-throws reasoning as `loadAddOnCandidates` immediately above.
  const packComponentCandidates = await loadPackComponentCandidates(
    createAdminHttp(await createServerApiClient()),
    locale,
  );

  // Degrades to NO PANEL rather than failing the whole page, same reasoning
  // as `loadAddOnCandidates` above: a category-tree outage should not block
  // writing a product.
  const categories = await listCategories(createAdminHttp(await createServerApiClient()))
    .then((response) => response.items)
    .catch(() => undefined);

  return (
    <PageTemplate title={t("newTitle")} description={t("newDescription")} width="admin">
      <ProductEditor
        currency={DEFAULT_CURRENCY}
        addOnCandidates={addOnCandidates}
        packComponentCandidates={packComponentCandidates}
        {...(initialKind === undefined ? {} : { initialKind })}
        {...(categories === undefined ? {} : { categories })}
      />
    </PageTemplate>
  );
}
