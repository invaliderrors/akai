import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { AffiliateEditor } from "@/components/admin/affiliate-editor";
import { PartnerLoginPanel } from "@/components/admin/partner-login-panel";
import { PartnerLinksManager } from "@/components/admin/partner-links-manager";
import { PageTemplate } from "@/components/shell/page-template";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MetricTile } from "@/components/ui/metric-tile";
import { Notice } from "@/components/ui/notice";
import Link from "next/link";
import { getAffiliate, listAffiliateLinks } from "@/lib/admin/api";
import { formatDate } from "@/lib/admin/discount-display";
import { AdminApiError } from "@/lib/admin/http";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { DEFAULT_CURRENCY } from "@/lib/admin/schemas";
import { createServerApiClient } from "@/lib/api/client";

/**
 * Edit one affiliate, and see their derived stats.
 *
 * THE 404 BRANCH KEYS ON THE ERROR CODE, not the HTTP status — same reasoning
 * `admin/discounts/[id]/page.tsx` gives for its own identical branch.
 *
 * COUPON ASSIGNMENT IS NOT HERE. It happens on the DISCOUNT's own edit
 * screen (`discount-form.tsx`'s affiliate picker), which calls the existing
 * `PATCH /admin/discounts/:id` widened with `affiliateId` — see
 * `AdminAffiliatesController`'s doc comment for why that route, and not one
 * here, owns the assignment. `discountCodes` below is a READ-ONLY list of
 * whichever coupons currently point at this affiliate.
 */
export default async function EditAffiliatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("admin.affiliates");

  const http = createAdminHttp(await createServerApiClient());

  let affiliate: Awaited<ReturnType<typeof getAffiliate>>;
  try {
    affiliate = await getAffiliate(http, id);
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

  const archived = affiliate.deletedAt !== null;

  // A links-fetch failure degrades to an empty list with a notice rather than
  // taking down the whole page — this is a secondary panel, not the resource
  // the route is named after.
  let links: Awaited<ReturnType<typeof listAffiliateLinks>> = [];
  let linksLoadFailed = false;
  try {
    links = await listAffiliateLinks(http, id);
  } catch {
    linksLoadFailed = true;
  }

  return (
    <PageTemplate
      title={affiliate.name}
      description={t("editDescription")}
      width="admin"
      titleAdornment={
        archived ? (
          <Badge tone="neutral" density="compact" label={t("state.ARCHIVED")} />
        ) : (
          <Badge tone="success" density="compact" label={t("state.ACTIVE")} />
        )
      }
      actions={
        <Link href="/admin/affiliates" className={buttonClassName({ variant: "standard" })}>
          {t("back")}
        </Link>
      }
    >
      <div className="grid gap-4">
        {!archived ? null : <Notice tone="warning">{t("archivedNotice")}</Notice>}

        {/* Stats, shown before the form: what this affiliate has actually
            earned is the first thing an operator opening it wants to know,
            and it is entirely read-only. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label={t("stats.redemptions")}
            value={{ kind: "text", value: String(affiliate.redemptionCount) }}
          />
          <MetricTile
            label={t("stats.revenue")}
            value={{
              kind: "money",
              amountMinor: affiliate.revenueMinor,
              currency: DEFAULT_CURRENCY,
            }}
          />
          <MetricTile
            label={t("stats.coupons")}
            value={{
              kind: "text",
              value:
                affiliate.discountCodes.length === 0
                  ? t("noCoupons")
                  : affiliate.discountCodes.join(", "),
            }}
          />
          <MetricTile
            label={t("stats.created")}
            value={{ kind: "text", value: formatDate(affiliate.createdAt) }}
          />
        </div>

        <Card>
          <AffiliateEditor affiliate={affiliate} />
        </Card>

        <Card>
          <PartnerLoginPanel
            affiliateId={affiliate.id}
            hasLogin={affiliate.hasLogin}
            email={affiliate.email}
          />
        </Card>

        <Card>
          {linksLoadFailed && <Notice tone="danger">{t("partnerLinks.loadFailed")}</Notice>}
          <PartnerLinksManager affiliateId={affiliate.id} initial={links} />
        </Card>
      </div>
    </PageTemplate>
  );
}

export const dynamic = "force-dynamic";
