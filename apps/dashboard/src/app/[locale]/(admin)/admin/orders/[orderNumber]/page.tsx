import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { AddressFields, CurrencyCode, Locale, Minor, OrderItem } from "@akai/contracts";
import { subtract } from "@akai/money";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { OrderShipments } from "@/components/admin/order-shipments";
import {
  OrderActions,
  ORDER_REFUND_PANEL_ID,
  ORDER_STATUS_PANEL_ID,
} from "@/components/admin/order-actions";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Money } from "@/components/ui/money";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type Column } from "@/components/ui/table";
import { Timeline, type TimelineEntry } from "@/components/ui/timeline";
import { TotalsList } from "@/components/ui/totals-list";
import { asLocale, formatDateTime } from "@/components/account/format";
import { PageTemplate } from "@/components/shell/page-template";
import { getOrder } from "@/lib/admin/api";
import { AdminApiError } from "@/lib/admin/http";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { createServerApiClient } from "@/lib/api/client";
import { canRecordShipment, unshippedLines } from "@/lib/admin/shipment-display";

/**
 * One order, in full — and, when it is in PAYMENT_MISMATCH, the decision screen
 * for the single loudest state this product has.
 *
 * EVERY LINE IS A SNAPSHOT taken at order time — product name, SKU, unit price,
 * tax rate and shipped batch are all copied onto the order rather than joined to
 * the live catalogue. Rendering them from the live product would retroactively
 * rewrite an invoice that has already been filed for tax, which is why this page
 * never looks a product up.
 *
 * THE MISMATCH PANEL OFFERS TWO RESOLUTIONS, NOT THREE. The artboard draws a
 * primary "Aceptar 59,85 € y continuar", and that action is illegal:
 * `ADMIN_ASSIGNABLE_STATUSES` excludes PAID and `assertAdminMayAssign` answers
 * 403, because an order becomes PAID only through a signature-verified provider
 * webhook whose reported amount matches ours. The two the code actually offers
 * are already drawn beside it — refund the difference (which lands
 * PARTIALLY_REFUNDED through `statusAfterRefund`) or move to CANCELLED — and
 * both are reached through the inspector panels that own their validation,
 * rather than duplicated here as a second set of buttons.
 *
 * THE CHARGED FIGURE IS NOT ON THIS SCREEN because it is not in the contract.
 * `orderSchema` is `.strict()` and carries our own totals only; there is no
 * payments endpoint in `lib/admin/api.ts`, so the provider's amount exists on
 * this page in exactly one place — the prose of the mismatch timeline event the
 * webhook wrote. Parsing an amount back out of a free-text `z.string()` to fill
 * a figure tile would be inventing a number and printing it next to the ledger's
 * real one.
 */
export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ locale: string; orderNumber: string }>;
}) {
  const { locale: rawLocale, orderNumber } = await params;
  const locale = asLocale(rawLocale);

  const t = await getTranslations("admin.orderDetail");
  const tOrders = await getTranslations("admin.orders");
  const tDocument = await getTranslations("documents");

  let order: Awaited<ReturnType<typeof getOrder>>;
  try {
    const http = createAdminHttp(await createServerApiClient());
    order = await getOrder(http, orderNumber);
  } catch (cause) {
    if (cause instanceof AdminApiError && cause.status === 404) {
      notFound();
    }
    return (
      <PageTemplate title={orderNumber} mono width="admin">
        <AdminErrorState cause={cause} title={t("loadErrorTitle")} />
      </PageTemplate>
    );
  }

  const currency = order.currency;
  // Through @akai/money's `subtract`, not a bare `-`: the operands are branded
  // Minor values and the result must stay one. Plain arithmetic silently
  // produces an unbranded number that no longer carries the guarantee that it
  // is an integer inside the range the ledger can settle.
  const remaining = subtract(order.grandTotal, order.refundedTotal);
  const isMismatch = order.status === "PAYMENT_MISMATCH";

  const itemColumns: readonly Column<OrderItem>[] = [
    {
      key: "item",
      header: t("itemColumns.item"),
      // A PACK'S OWN VARIANT NEVER APPEARS HERE — this table shows the REAL
      // component lines an "add pack to cart" wrote (see `OrderItem`'s own
      // `packInstanceId` comment), one row per product exactly like any other
      // order. The badge is the only thing that says a row came in as part of
      // a pack rather than bought on its own; no structural change is needed
      // beyond it — grouping N sibling rows under one heading would need the
      // pack's own name, which `OrderItem` does not carry and is not worth a
      // second lookup for a label this small.
      cell: (item) => (
        <>
          {item.productName}
          {item.variantName === null ? null : (
            <span className="text-[var(--label-secondary)]"> · {item.variantName}</span>
          )}
          {item.packInstanceId !== null && (
            <span className="ms-1.5 inline-block align-middle">
              <Badge tone="neutral" density="compact" label={t("itemColumns.packBadge")} />
            </span>
          )}
        </>
      ),
    },
    {
      key: "sku",
      header: t("itemColumns.sku"),
      kind: "identifier",
      cell: (item) => item.sku,
    },
    {
      key: "quantity",
      header: t("itemColumns.quantity"),
      kind: "numeric",
      cell: (item) => item.quantity,
    },
    {
      key: "unitPrice",
      header: t("itemColumns.unitPrice"),
      kind: "numeric",
      cell: (item) => (
        <Money amount={item.unitPriceGross} currency={currency} locale={locale} />
      ),
    },
    {
      key: "tax",
      header: t("itemColumns.tax"),
      kind: "numeric",
      cell: (item) => <Money amount={item.taxAmount} currency={currency} locale={locale} />,
    },
    {
      key: "lineTotal",
      header: t("itemColumns.lineTotal"),
      kind: "numeric",
      cell: (item) => (
        <Money amount={item.lineTotalGross} currency={currency} locale={locale} />
      ),
    },
  ];

  /*
   * Newest first, sorted here rather than assumed.
   *
   * `orderEventSchema` says nothing about ordering, and the decision the
   * operator is making lives at the top of the rail. ISO-8601 UTC timestamps
   * compare lexicographically in chronological order, so a string comparison is
   * the correct one and does not go through `Date`.
   */
  const events: readonly TimelineEntry[] = [...order.events]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map((event) => ({
      id: event.id,
      // `type` and `message` are open `z.string()` in the contract — there is no
      // closed enum to key a translation off — so they render verbatim. That is
      // honest on an operator screen and would be a defect on a customer one,
      // which is why `Timeline` is not mounted on a customer route.
      type: event.type,
      message: event.message,
      isInternal: event.isInternal,
      createdAt: event.createdAt,
      timestamp: formatDateTime(event.createdAt, locale),
    }));

  return (
    <PageTemplate
      title={order.orderNumber}
      mono
      titleAdornment={
        <StatusBadge domain="order" value={order.status} density="compact" />
      }
      description={t("subtitle", {
        email: order.email,
        date: formatDateTime(order.placedAt, locale),
      })}
      breadcrumb={{
        label: t("back"),
        links: [{ label: tOrders("title"), href: "/admin/orders" }],
      }}
      width="admin"
    >
      <div className="grid gap-4">
        {isMismatch && (
          /*
           * THE ATTENTION TREATMENT, second and last sanctioned appearance on
           * this screen (the row rail in the list is the same state). Solid
           * `--attention-fill` down the leading edge plus the danger ring, drawn
           * as ONE box-shadow: two `shadow-[…]` utilities on one element resolve
           * by the order Tailwind emits them, which no call site controls, so
           * this cannot be a `<Card className>`.
           */
          <section
            role="alert"
            aria-labelledby="order-mismatch-heading"
            className="grid gap-3 rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-[var(--card-p)] shadow-[inset_3px_0_0_var(--attention-fill),0_0_0_1px_var(--danger-ring)]"
          >
            <div className="flex items-start gap-2.5">
              <Icon
                name="triangle-alert"
                size={18}
                className="mt-px flex-none text-[var(--danger)]"
              />
              <div>
                <p
                  id="order-mismatch-heading"
                  className="m-0 text-[15px] leading-5 font-semibold tracking-[-0.23px] text-[var(--label)]"
                >
                  {t("mismatchTitle")}
                </p>
                <p className="m-0 mt-0.5 text-[13px] leading-[1.4] text-[var(--label-secondary)]">
                  {t("mismatchBody")}
                </p>
              </div>
            </div>

            <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 text-[12px]">
              <Figure
                label={t("mismatchOrderTotal")}
                amount={order.grandTotal}
                currency={currency}
                locale={locale}
              />
              <Figure
                label={t("refundAlready")}
                amount={order.refundedTotal}
                currency={currency}
                locale={locale}
              />
            </dl>

            {/*
              Plain anchors, not `Link`: these are same-document fragments, and
              next-intl's Link would prefix the locale and navigate away. They
              point AT the two controls rather than repeating them, so there is
              one refund form with one set of validation and one idempotency key.
            */}
            <div className="flex flex-wrap justify-end gap-2">
              <a
                href={`#${ORDER_STATUS_PANEL_ID}`}
                className={buttonClassName({ variant: "standard" })}
              >
                {t("mismatchCancel")}
              </a>
              <a
                href={`#${ORDER_REFUND_PANEL_ID}`}
                className={buttonClassName({ variant: "destructivePlain" })}
              >
                {t("mismatchRefund")}
              </a>
            </div>
          </section>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
          <div className="grid min-w-0 gap-4">
            <Card flush title={t("items")} titleId="order-items-heading">
              <DataTable
                caption={t("items")}
                columns={itemColumns}
                rows={order.items}
                rowKey={(item) => item.id}
                // The card already draws the surface; a second frame inside it
                // reads as a mistake. No sticky header either — this table is
                // as long as the order and never its own scrollport.
                frame={false}
                stickyHeader={false}
                minWidth="regular"
              />
              <div className="border-t border-[var(--separator-weak)] px-[var(--card-p)] py-[var(--cell-py)]">
                <TotalsList
                  className="ml-auto max-w-[280px]"
                  density="compact"
                  currency={currency}
                  locale={locale}
                  subtotal={{ label: t("totalLabels.subtotal"), amount: order.subtotal }}
                  discount={{ label: t("totalLabels.discount"), amount: order.discountTotal }}
                  shipping={{ label: t("totalLabels.shipping"), amount: order.shippingTotal }}
                  taxIncluded={{ label: t("totalLabels.tax"), amount: order.taxTotal }}
                  total={{ label: t("totalLabels.grandTotal"), amount: order.grandTotal }}
                  refunded={{ label: t("totalLabels.refunded"), amount: order.refundedTotal }}
                />
                {order.invoiceNumber === null ? null : (
                  <p className="m-0 mt-2 text-right text-[11px] text-[var(--label-secondary)]">
                    {t("invoice", { number: order.invoiceNumber })}
                  </p>
                )}
              </div>
            </Card>

            <OrderShipments
              orderNumber={order.orderNumber}
              locale={locale}
              shipments={order.shipments}
              toShip={canRecordShipment(order) ? unshippedLines(order) : []}
            />

            <Card title={t("customerDocument")} titleId="order-customer-document" titleAs="h2">
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                <dt className="text-[var(--label-secondary)]">{t("documentType")}</dt>
                <dd className="m-0">{tDocument(`types.${order.documentType}`)}</dd>
                <dt className="text-[var(--label-secondary)]">{t("documentNumber")}</dt>
                <dd className="m-0 font-mono text-[12px]">{order.documentNumber}</dd>
              </dl>
            </Card>

            <div className="grid gap-4 sm:grid-cols-2">
              <AddressPanel
                id="order-shipping-address"
                title={t("shippingAddress")}
                address={order.shippingAddress}
              />
              <AddressPanel
                id="order-billing-address"
                title={t("billingAddress")}
                address={order.billingAddress}
              />
            </div>

            <Card title={t("timeline")} titleId="order-timeline-heading">
              {events.length === 0 ? (
                <p className="m-0 text-[13px] text-[var(--label-secondary)]">
                  {t("timelineEmpty")}
                </p>
              ) : (
                /*
                 * INTERNAL NOTES ARE VISIBLY INTERNAL. `Timeline` forces a
                 * warning-toned card, a lock glyph and the words "Solo
                 * operadores" onto every `isInternal` entry, and the caller
                 * cannot dress one down. Today both halves render identically,
                 * which is how a note gets pasted into a reply to the customer.
                 *
                 * No composer: there is no add-note endpoint in
                 * `lib/admin/api.ts`, and the only way to write a timeline entry
                 * from this screen is the note field on a status transition.
                 */
                <Timeline labelledBy="order-timeline-heading" entries={events} />
              )}
            </Card>
          </div>

          <aside className="grid gap-4">
            <OrderActions
              orderNumber={order.orderNumber}
              status={order.status}
              currency={currency}
              locale={locale}
              remainingRefundable={remaining}
              refundedTotal={order.refundedTotal}
            />
          </aside>
        </div>
      </div>
    </PageTemplate>
  );
}

interface FigureProps {
  readonly label: string;
  readonly amount: Minor;
  readonly currency: CurrencyCode;
  readonly locale: Locale;
}

/** One figure tile inside the decision panel: a label over a 17px amount. */
function Figure({ label, amount, currency, locale }: FigureProps) {
  return (
    <div className="rounded-[var(--r-check)] bg-[var(--bg-grouped)] px-3 py-2.5">
      <dt className="m-0 text-[var(--label-secondary)]">{label}</dt>
      <dd className="m-0 mt-0.5 text-[17px]">
        <Money amount={amount} currency={currency} locale={locale} emphasis />
      </dd>
    </div>
  );
}

interface AddressPanelProps {
  readonly id: string;
  readonly title: string;
  readonly address: AddressFields;
}

function AddressPanel({ id, title, address }: AddressPanelProps) {
  return (
    <Card title={title} titleId={id} titleAs="h2">
      <address className="text-[13px] leading-[1.45] not-italic text-[var(--label)]">
        {address.firstName} {address.lastName}
        {address.company === null ? null : (
          <>
            <br />
            {address.company}
          </>
        )}
        <br />
        {address.line1}
        {address.line2 === null ? null : (
          <>
            <br />
            {address.line2}
          </>
        )}
        <br />
        {address.city}, {address.region}
        {address.postalCode === null ? "" : ` ${address.postalCode}`}
        <br />
        {address.countryCode}
        {address.phone === null ? null : (
          <>
            <br />
            <span className="font-mono text-[12px]">{address.phone}</span>
          </>
        )}
      </address>
    </Card>
  );
}

export const dynamic = "force-dynamic";
