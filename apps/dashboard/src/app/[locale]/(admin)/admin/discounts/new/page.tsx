import { getTranslations } from "next-intl/server";

import { DiscountEditor } from "@/components/admin/discount-editor";
import { PageTemplate } from "@/components/shell/page-template";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { listAffiliates } from "@/lib/admin/api";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { createServerApiClient } from "@/lib/api/client";

/**
 * Create a discount code.
 *
 * A server component that renders one client boundary, exactly like the product
 * create page: nothing here needs state, and keeping the page on the server
 * means the admin copy never enters a customer's bundle.
 *
 * There is no currency prop. A discount's `currency` is a RESTRICTION — null
 * means "applies in any currency" — not the store's base currency, so the form
 * owns that field and falls back to `DEFAULT_CURRENCY` only to decide how many
 * decimals an amount is entered with.
 */
export default async function NewDiscountPage() {
  const t = await getTranslations("admin.discounts");

  // Degrades to `undefined` on failure — same as the product page's category
  // fetch: a coupon can still be created without an affiliate picker, it just
  // cannot be assigned one until the list loads.
  const affiliates = await listAffiliates(
    createAdminHttp(await createServerApiClient()),
    { limit: 100 },
  ).then(
    (page) => page.items,
    () => undefined,
  );

  return (
    <PageTemplate
      title={t("newTitle")}
      description={t("newDescription")}
      width="admin"
      actions={
        <Link href="/admin/discounts" className={buttonClassName({ variant: "standard" })}>
          {t("back")}
        </Link>
      }
    >
      <Card>
        <DiscountEditor {...(affiliates === undefined ? {} : { affiliates })} />
      </Card>
    </PageTemplate>
  );
}

export const dynamic = "force-dynamic";
