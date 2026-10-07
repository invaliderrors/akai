import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { DiscountEditor } from "@/components/admin/discount-editor";
import { PageTemplate } from "@/components/shell/page-template";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MetricTile } from "@/components/ui/metric-tile";
import { Notice } from "@/components/ui/notice";
import { StatusBadge } from "@/components/ui/status-badge";
import Link from "next/link";
import { getDiscount, listAffiliates } from "@/lib/admin/api";
import { formatDate, resolveState } from "@/lib/admin/discount-display";
import { AdminApiError } from "@/lib/admin/http";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { createServerApiClient } from "@/lib/api/client";

/**
 * Edit one discount code.
 *
 * THE 404 BRANCH KEYS ON THE ERROR CODE, not on the HTTP status. `NOT_FOUND` is
 * a member of the platform's closed `ErrorCode` enum and is what the API's
 * exception filter emits for a missing row; the status is a derived projection
 * of it (`ERROR_STATUS` in @akai/contracts) and a proxy is free to rewrite it.
 * Branching on the code means a 404 produced by an edge cache — which carries no
 * error envelope at all — falls through to the error panel where it belongs,
 * instead of being reported to the operator as "this coupon does not exist".
 *
 * Everything else renders an error panel with TRANSLATED copy. The thrown
 * `AdminApiError.message` is the API's own English, written for a log, and this
 * page never shows it.
 *
 * THE LIST CAN EDIT A CODE INLINE, and this route is still here on purpose: it
 * is the linkable, bookmarkable URL a freshly created code lands on, and it is
 * the only place the read-only usage figures fit. Both render the SAME
 * `DiscountEditor`, so there is one form in the product, in two placements.
 */
export default async function EditDiscountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("admin.discounts");

  const http = createAdminHttp(await createServerApiClient());

  let discount: Awaited<ReturnType<typeof getDiscount>>;
  try {
    discount = await getDiscount(http, id);
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

  const archived = discount.deletedAt !== null;

  // Degrades to `undefined` on failure — see the new-discount page's own
  // identical fetch for why that is the right failure mode here.
  const affiliates = await listAffiliates(http, { limit: 100 }).then(
    (page) => page.items,
    () => undefined,
  );

  return (
    <PageTemplate
      title={t("editTitle", { code: discount.code })}
      description={t("editDescription")}
      width="admin"
      // Inside the `<h1>`: the state qualifies the title, and a badge that
      // qualifies a heading while sitting outside it is a floating fragment
      // whose relationship to the heading exists only visually.
      titleAdornment={
        <StatusBadge
          domain="discount"
          value={resolveState(discount, Date.now())}
          density="compact"
        />
      }
      actions={
        <Link href="/admin/discounts" className={buttonClassName({ variant: "standard" })}>
          {t("back")}
        </Link>
      }
    >
      <div className="grid gap-4">
        {!archived ? null : (
          // `warning`, not `danger`: an archived code is a deliberate end state,
          // not a failure. Nothing here needs an assertive announcement.
          <Notice tone="warning">{t("archivedNotice")}</Notice>
        )}

        {/* Usage, shown before the form: how much of a code's allowance is spent
            is the first thing an operator opening it wants to know, and it is
            the one thing on this screen that is read-only by construction. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label={t("stats.timesRedeemed")}
            value={{ kind: "text", value: String(discount.timesRedeemed) }}
          />
          <MetricTile
            label={t("stats.remaining")}
            value={{
              kind: "text",
              value:
                discount.remainingRedemptions === null
                  ? t("unlimited")
                  : String(discount.remainingRedemptions),
            }}
          />
          <MetricTile
            label={t("stats.created")}
            value={{ kind: "text", value: formatDate(discount.createdAt) }}
          />
          <MetricTile
            label={t("stats.updated")}
            value={{ kind: "text", value: formatDate(discount.updatedAt) }}
          />
        </div>

        <Card>
          <DiscountEditor
            discount={discount}
            {...(affiliates === undefined ? {} : { affiliates })}
          />
        </Card>
      </div>
    </PageTemplate>
  );
}

export const dynamic = "force-dynamic";
