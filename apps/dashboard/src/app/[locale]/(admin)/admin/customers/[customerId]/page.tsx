import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { Locale, OrderSummary } from "@akai/contracts";

import { Link } from "@/i18n/navigation";
import { createServerApiClient } from "@/lib/api/client";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { getCustomer, listOrders } from "@/lib/admin/api";
import { AdminApiError } from "@/lib/admin/http";
import { DEFAULT_CURRENCY } from "@/lib/admin/schemas";
import { asLocale, formatDate, fullName } from "@/components/account/format";
import { AdminErrorState } from "@/components/admin/admin-error-state";
import { PageTemplate } from "@/components/shell/page-template";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MetricTile } from "@/components/ui/metric-tile";
import { Money } from "@/components/ui/money";
import { Notice } from "@/components/ui/notice";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/states";
import { DataTable, type Column, type RowTone } from "@/components/ui/table";

/**
 * One customer, with their order history. READ-ONLY: nothing on this screen
 * mutates the account, and that is the design rather than a gap — there is no
 * admin endpoint behind a name change, a role change or a deletion.
 *
 * THE ORDERS ARE FETCHED BY EMAIL, NOT BY CUSTOMER ID, because that is the
 * filter the admin order endpoint offers — and because email is also the claim
 * key for guest orders. A customer who checked out as a guest before
 * registering has orders that carry no customerId at all; keying on the id
 * alone would hide exactly the history a support agent is looking for.
 *
 * THIS IS A STANDALONE ROUTE, deliberately, against the artboard's "detail
 * folded into an inspector under the list". The route is linkable, the order
 * table and support workflows deep-link into it, and the inspector composition
 * would put a second fetch inside a paginated list page — so a stalled customer
 * query would stall the list. Recorded as a divergence from the drawing rather
 * than as an oversight.
 *
 * THERE ARE FOUR STAT TILES, NOT SIX. The drawn "Ticket medio" and
 * "Reembolsado" are gone: `adminCustomerSchema` is `.strict()` and carries
 * `orderCount`, `lifetimeValueMinor`, `lastOrderAt` and `marketingConsentAt`
 * and nothing else, so neither figure can be computed from what the API sends.
 * Averaging lifetime value over order count would produce a number that looks
 * like a mean and is not one — it ignores refunds, which is the whole reason
 * the second tile was drawn beside it.
 */

/** Typographic placeholder for a field the API has nothing in. Not prose. */
const NO_VALUE = "—";

/** One cursor page of history. Deep history belongs in the order list, filtered. */
const ORDER_HISTORY_LIMIT = 25;

export default async function AdminCustomerDetailPage({
  params,
}: {
  params: Promise<{ locale: string; customerId: string }>;
}) {
  const { locale: rawLocale, customerId } = await params;
  const locale = asLocale(rawLocale);
  const t = await getTranslations("admin.customers");
  const tUi = await getTranslations("ui");
  const tCommon = await getTranslations("common");
  const tAdmin = await getTranslations("admin.common");

  const http = createAdminHttp(await createServerApiClient());

  let customer: Awaited<ReturnType<typeof getCustomer>>;
  try {
    customer = await getCustomer(http, customerId);
  } catch (cause) {
    // Branched on the CODE, not on the status. The status is a derived
    // projection of the code (`ERROR_STATUS` in @akai/contracts) and any proxy
    // between here and the API is free to invent one — a cache returning a bare
    // 404 with no envelope must land in the error panel, not tell an operator
    // that this customer has been deleted.
    if (cause instanceof AdminApiError && cause.code === "NOT_FOUND") {
      notFound();
    }
    return (
      <PageTemplate title={t("title")} width="admin">
        <AdminErrorState cause={cause} title={t("detailErrorTitle")} />
      </PageTemplate>
    );
  }

  /*
   * ALLOWED TO FAIL INDEPENDENTLY: a broken order query must not blank out the
   * profile a support agent is on the phone about. The cause is KEPT rather
   * than collapsed to `null`, because `AdminErrorState` is what tells a stale
   * second factor — fixable, and it says how — from a genuine upstream failure,
   * and it needs the envelope to do it.
   */
  let orders: Awaited<ReturnType<typeof listOrders>> | null = null;
  let ordersFailure: unknown = null;
  try {
    orders = await listOrders(http, { email: customer.email, limit: ORDER_HISTORY_LIMIT });
  } catch (cause) {
    ordersFailure = cause;
  }

  const erased = customer.anonymisedAt !== null;
  const name = fullName(customer.firstName, customer.lastName);

  const orderColumns: readonly Column<OrderSummary>[] = [
    {
      key: "orderNumber",
      header: t("orderColumns.order"),
      // `identifier`, so the column takes the mono face: an order number is
      // read back character by character against a packing slip or an email,
      // which is the one thing a fixed pitch is for. Money never gets it.
      kind: "identifier",
      cell: (order) => (
        <Link href={`/admin/orders/${order.orderNumber}`}>{order.orderNumber}</Link>
      ),
    },
    {
      key: "status",
      header: t("orderColumns.status"),
      cell: (order) => <StatusBadge domain="order" value={order.status} density="compact" />,
    },
    {
      key: "itemCount",
      header: t("orderColumns.items"),
      kind: "numeric",
      cell: (order) => formatCount(order.itemCount, locale),
    },
    {
      key: "placedAt",
      header: t("orderColumns.placed"),
      cell: (order) => formatDate(order.placedAt, locale),
    },
    {
      key: "grandTotal",
      header: t("orderColumns.total"),
      kind: "numeric",
      // `Money`, not `AggregateMoney`: `grandTotal` is a real settled amount and
      // arrives branded `Minor` from the contract parse. The branded path is the
      // right one everywhere it fits — the tile below is the exception, not this.
      cell: (order) => (
        <Money amount={order.grandTotal} currency={order.currency} locale={locale} />
      ),
    },
  ];

  return (
    <PageTemplate
      title={customer.email}
      description={name ?? t("noName")}
      width="admin"
      actions={
        <>
          <StatusBadge domain="role" value={customer.role} density="compact" />
          {customer.twoFactorEnabled && (
            <Badge tone="success" density="compact" label={t("twoFactor")} />
          )}
          {/*
            ERASURE IS NOT A STATUS DOMAIN — `lib/status` covers the twelve
            badged vocabularies and anonymisation is a nullable timestamp, so it
            is a plain warning capsule with its own translated label.
          */}
          {erased && <Badge tone="warning" density="compact" label={t("erased")} />}
        </>
      }
    >
      {/*
        THE FOUR BLOCKS ARE WRAPPED, not handed to `PageTemplate` loose:
        the template drops its whole `children` slot into ONE grid cell, so
        siblings there would sit flush against each other. This wrapper owns
        their rhythm — and `min-w-0`, here and on the table's section, is what
        lets the order table scroll inside its own wrapper instead of
        stretching the page.
      */}
      <div className="grid min-w-0 gap-4">
        {/*
          The erasure notice is `warning` and NOT `danger`: nothing is wrong.
          The account is in the state the customer asked for, and the sentence
          exists so an operator reading a row full of blanks knows the erasure
          SUCCEEDED rather than that the record is corrupt.
        */}
        {erased && <Notice tone="warning">{t("erasureNotice")}</Notice>}

        {/* The drawn 8px gutter: four tiles read as one figure block. */}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label={t("stats.orders")}
            value={{ kind: "text", value: formatCount(customer.orderCount, locale) }}
          />
          <MetricTile
            label={t("stats.lifetimeValue")}
            /*
             * `money`, which routes through `AggregateMoney` — NEVER `toMinor`.
             * `lifetimeValueMinor` is declared `z.number().int()` on purpose: an
             * aggregate has no ceiling where the branded `Minor` does, so
             * branding it would make the dashboard throw on a successful
             * business, and an `isMinor` guard would fall through to a bare
             * integer where a euro figure belongs. Display only; it never settles.
             */
            value={{
              kind: "money",
              amountMinor: customer.lifetimeValueMinor,
              currency: DEFAULT_CURRENCY,
              locale,
            }}
          />
          <MetricTile
            label={t("stats.lastOrder")}
            value={{
              kind: "text",
              value:
                customer.lastOrderAt === null
                  ? NO_VALUE
                  : formatDate(customer.lastOrderAt, locale),
            }}
          />
          <MetricTile
            label={t("stats.emailVerified")}
            // Yes/No rather than the verification DATE the artboard draws: the
            // tile answers "can this customer receive transactional mail",
            // which is the question support is asking, and a date answers it
            // only by implication. The moment itself is one row down.
            value={{
              kind: "text",
              value: customer.emailVerifiedAt === null ? tAdmin("no") : tAdmin("yes"),
            }}
          />
        </div>

        <Card title={t("account")} titleId="customer-account" titleAs="h2">
          {/*
            A two-column grid of label/value pairs, which is why every `Row`
            below returns a BARE FRAGMENT: a wrapper element around each pair
            would become the grid item and collapse the two tracks into one
            column of nested boxes. `dt` and `dd` are the grid items themselves.
          */}
          <dl className="m-0 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr_auto_1fr]">
            <Row label={t("rows.phone")} value={customer.phone ?? NO_VALUE} />
            <Row
              label={t("rows.preferredLocale")}
              // The language's own name, from the one place the product spells
              // them — the same catalogue the account menu's switcher reads —
              // so an operator never meets a bare "es" in a field called Idioma.
              value={tCommon(`localeName.${customer.preferredLocale}`)}
            />
            <Row
              label={t("rows.registered")}
              value={formatDate(customer.createdAt, locale)}
            />
            <Row
              label={t("rows.marketingConsent")}
              value={
                customer.marketingConsentAt === null
                  ? t("marketingNotGiven")
                  : formatDate(customer.marketingConsentAt, locale)
              }
            />
          </dl>
        </Card>

        <section aria-labelledby="customer-orders" className="min-w-0">
          {/*
            An `<h2>` rather than a `Card` title: the table draws its own
            surface, and a card wrapping a card is the one shape the elevation
            rules in `ui/card.tsx` exist to prevent. The id names the section,
            so the whole region has one accessible name instead of none.
          */}
          <h2
            id="customer-orders"
            className="m-0 mb-2 text-[15px] leading-5 font-semibold tracking-[-0.23px] text-[var(--label)]"
          >
            {t("orderHistory")}
          </h2>
          <DataTable
            caption={t("orderHistory")}
            columns={orderColumns}
            rows={orders === null ? [] : orders.items}
            rowKey={(order) => order.id}
            rowTone={orderTone}
            minWidth="narrow"
            error={
              ordersFailure === null ? undefined : (
                // `density="table"` so the failure is the quieter of the two
                // sizes: the column headings are still on screen above it, and
                // a full-page panel under them would read as the whole page
                // failing rather than one section of it.
                <AdminErrorState
                  cause={ordersFailure}
                  title={t("ordersErrorTitle")}
                  density="table"
                />
              )
            }
            empty={
              <EmptyState
                density="table"
                icon="package"
                title={t("ordersEmpty")}
                body={tUi("emptyBody")}
              />
            }
          />
        </section>
      </div>
    </PageTemplate>
  );
}

/**
 * The attention rail, spent on ONE of its two sanctioned uses.
 *
 * `PAYMENT_MISMATCH` means the provider settled an amount that is not ours: the
 * order is frozen and only a human takes it out, because the state machine
 * refuses `PAID` from every automated path. It is drawn here as well as on the
 * order list because a support agent reading a customer's history has to see
 * the frozen order without opening it — the same state, not a second use.
 *
 * Unlike the stock case there is no ACTIVE-style gate: an order in
 * PAYMENT_MISMATCH is somebody's problem unconditionally.
 */
function orderTone(order: OrderSummary): RowTone {
  return order.status === "PAYMENT_MISMATCH" ? "attention" : "default";
}

/**
 * Counts go through `Intl`, not `String(n)`: 1.204 in Spanish and 1,204 in
 * English, matching the grouped figures beside them in the money column.
 */
function formatCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "es" ? "es-CO" : "en-US").format(value);
}

interface RowProps {
  readonly label: string;
  readonly value: string;
}

/**
 * ONE label/value pair, as a FRAGMENT with no wrapper — see the note on the
 * `<dl>` above. `dt` and `dd` are the grid items.
 */
function Row({ label, value }: RowProps) {
  return (
    <>
      <dt className="text-[var(--label-secondary)]">{label}</dt>
      <dd className="m-0 text-[var(--label)]">{value}</dd>
    </>
  );
}

export const dynamic = "force-dynamic";
