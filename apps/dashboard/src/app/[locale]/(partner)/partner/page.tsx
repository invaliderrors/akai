import { getTranslations } from "next-intl/server";
import { AccountErrorPanel } from "@/components/account/account-error-panel";
import { PageTemplate } from "@/components/shell/page-template";
import { Card } from "@/components/ui/card";
import { MetricTile } from "@/components/ui/metric-tile";
import { createServerApiClient } from "@/lib/api/client";
import { getPartnerStats } from "@/lib/partner/partner-api";

/** Per-partner and mutable; never statically cached. */
export const dynamic = "force-dynamic";

/**
 * The partner's ONE page: their discount code(s), and how many times a code
 * has been used. Nothing else — see `(partner)/layout.tsx`'s own doc comment
 * for why there is no nav rail to put a second page behind.
 *
 * `getPartnerStats` calls `GET /partner/me`, which derives the affiliate row
 * from the caller's own session server-side — this page never holds, reads
 * or could tamper with an affiliate id.
 */
export default async function PartnerPage() {
  const t = await getTranslations("partner");
  const client = await createServerApiClient();
  const stats = await getPartnerStats(client);

  if (!stats.ok) {
    return <AccountErrorPanel title={t("title")} error={stats.error} />;
  }

  return (
    <PageTemplate title={t("title")} description={t("description")} width="reading">
      <div className="grid gap-4 sm:grid-cols-2">
        <MetricTile
          label={t("codeLabel")}
          value={{
            kind: "text",
            value:
              stats.data.discountCodes.length === 0
                ? t("noCode")
                : stats.data.discountCodes.join(", "),
          }}
        />
        <MetricTile
          label={t("usageLabel")}
          value={{ kind: "text", value: String(stats.data.redemptionCount) }}
        />
      </div>
      <Card>
        <p className="m-0 text-[13px] text-[var(--label-secondary)]">{t("explainer")}</p>
      </Card>
    </PageTemplate>
  );
}
