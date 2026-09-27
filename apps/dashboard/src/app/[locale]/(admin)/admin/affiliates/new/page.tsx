import { getTranslations } from "next-intl/server";

import { AffiliateEditor } from "@/components/admin/affiliate-editor";
import { PageTemplate } from "@/components/shell/page-template";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";

/**
 * Create an affiliate. Mirrors `admin/discounts/new/page.tsx` exactly — a
 * server component rendering one client boundary, so the admin copy never
 * enters a customer's bundle.
 */
export default async function NewAffiliatePage() {
  const t = await getTranslations("admin.affiliates");

  return (
    <PageTemplate
      title={t("newTitle")}
      description={t("newDescription")}
      width="admin"
      actions={
        <Link href="/admin/affiliates" className={buttonClassName({ variant: "standard" })}>
          {t("back")}
        </Link>
      }
    >
      <Card>
        <AffiliateEditor />
      </Card>
    </PageTemplate>
  );
}

export const dynamic = "force-dynamic";
