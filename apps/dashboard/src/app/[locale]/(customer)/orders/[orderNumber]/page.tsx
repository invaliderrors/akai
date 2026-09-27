import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { AccountErrorPanel } from "@/components/account/account-error-panel";
import { asLocale, formatDateTime } from "@/components/account/format";
import { OrderDetailView } from "@/components/account/order-detail";
import { PageTemplate } from "@/components/shell/page-template";
import { buttonClassName } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Link } from "@/i18n/navigation";
import { createAccountApi } from "@/lib/account";
import { createServerApiClient } from "@/lib/api/client";

export const dynamic = "force-dynamic";

interface OrderDetailPageProps {
  /** Next 15 hands route params as a promise. */
  readonly params: Promise<{ readonly orderNumber: string }>;
}

/**
 * One order, in full.
 *
 * A 404 from the API becomes a real Next `notFound()` rather than an error
 * panel. That is deliberate and it matters for privacy: the API returns 404 —
 * never 403 — for an order belonging to someone else, precisely so the response
 * cannot confirm that the order exists. Rendering "you don't have access to
 * this order" here would leak exactly the fact the API refused to reveal, since
 * order numbers are sequential and therefore guessable.
 *
 * The page owns the header: the order NUMBER is the title (mono — it is an
 * identifier a customer reads back to support character by character) and the
 * status is its adornment, rendered inside the `<h1>` so the badge that
 * qualifies the title is part of it rather than a fragment floating beside it.
 */
export default async function OrderDetailPage({ params }: OrderDetailPageProps) {
  const { orderNumber } = await params;
  const t = await getTranslations("account.orderDetail");
  const tNav = await getTranslations("nav");
  const locale = asLocale(await getLocale());

  const account = createAccountApi(await createServerApiClient());
  const result = await account.getOrder(orderNumber);

  if (!result.ok) {
    if (result.error.code === "NOT_FOUND") {
      notFound();
    }
    return (
      <AccountErrorPanel
        title={t("title", { orderNumber })}
        error={result.error}
      />
    );
  }

  const { order } = result.data;

  return (
    <PageTemplate
      width="reading"
      mono
      title={order.orderNumber}
      titleAdornment={<StatusBadge domain="order" value={order.status} />}
      description={t("placedOn", { date: formatDateTime(order.placedAt, locale) })}
      // ANCESTORS ONLY, so the crumb is the order LIST and not this page. The
      // landmark is named with the back-link copy because that is what the
      // single crumb is for here — "Volver a mis pedidos" says where it goes,
      // which a bare "Pedidos" repeated from the link would not.
      breadcrumb={{ label: t("back"), links: [{ label: tNav("orders"), href: "/orders" }] }}
      {...(order.status === "DELIVERED"
        ? {
            // Gated on DELIVERED, though the artboard draws the action on a
            // shipped order: the returns page derives its eligible set
            // server-side from delivery, so offering it earlier lands the
            // customer on a picker that cannot list this order. The 14-day
            // window is that page's rule and is deliberately not restated here
            // — one place decides eligibility.
            actions: (
              <Link
                href="/returns"
                className={buttonClassName({ variant: "standard", size: "comfortable" })}
              >
                {t("requestReturn")}
              </Link>
            ),
          }
        : {})}
    >
      <OrderDetailView detail={result.data} />
    </PageTemplate>
  );
}
