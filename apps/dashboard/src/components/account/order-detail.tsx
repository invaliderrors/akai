import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type {
  AddressFields,
  CurrencyCode,
  Order,
  OrderItem,
  OrderShipment,
} from "@akai/contracts";

import { Card, SectionHeader } from "@/components/ui/card";
import { ContentRow, GroupedList } from "@/components/ui/grouped-list";
import { Icon } from "@/components/ui/icon";
import { Money } from "@/components/ui/money";
import { StatusBadge } from "@/components/ui/status-badge";
import { TotalsList } from "@/components/ui/totals-list";
import type { OrderDetail } from "@/lib/account";

import { formatDate, formatDateTime } from "./format";

/**
 * A single order, in full.
 *
 * EVERY VALUE ON THIS PAGE IS A SNAPSHOT. `orderItemSchema` copies the product
 * name, variant, SKU, unit price and tax rate at order time, and this component
 * renders those copies — it never joins back to the live catalogue. That is a
 * legal requirement, not an optimisation: a product renamed or repriced next
 * year must not retroactively rewrite an invoice that has already been filed
 * for tax. The same reasoning applies to the addresses, which are snapshotted
 * columns rather than foreign keys into the address book.
 *
 * NO `"use client"`, and nothing here needs one: no state, no effect, no
 * handler. `next-intl` ships a `react-server` condition, so `useTranslations`
 * resolves to the RSC implementation when the page renders this
 * on the server and to the context hook when a test wraps it in
 * `NextIntlClientProvider`.
 *
 * IT RENDERS NO `<h1>` AND NO BACK LINK. The page owns both through
 * `PageTemplate` — the order number is the title, the status badge its
 * adornment — so a second heading here would give the document two.
 *
 * DIVERGENCE FROM THE ARTBOARD, RECORDED: the drawn screen folds the totals
 * into the foot of the items card with no label of their own. They are a
 * separately labelled group here because `order-totals-heading` has to name a
 * region a screen-reader user can jump to, and an unlabelled `<dl>` at the
 * bottom of a list of items is exactly the block that reads as more items.
 */

export interface OrderDetailViewProps {
  readonly detail: OrderDetail;
}

export function OrderDetailView({ detail }: OrderDetailViewProps) {
  const { order, shipments, payment } = detail;

  return (
    <div className="grid gap-5">
      <DeliveryProgress order={order} shipments={shipments} />
      <ShipmentsSection shipments={shipments} />
      <OrderItemsSection order={order} />
      <OrderTotalsSection order={order} />

      <div className="grid gap-5 sm:grid-cols-2">
        <PaymentSection order={order} payment={payment} />
        <InvoiceSection order={order} />
      </div>

      <AddressesSection order={order} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

interface GroupProps {
  /**
   * The id the enclosing `<section>` names itself with. Six of them are pinned
   * by the tests and by anything deep-linking into this screen, so they are
   * written out at each call site rather than derived from the title.
   */
  readonly id: string;
  /** Already translated. */
  readonly title: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * One labelled group: an uppercase header and whatever card sits under it.
 *
 * The `<section>` and the heading are wired the way `SectionHeader` was built
 * for — the id lives on the heading, and the section points at it — so every
 * group on this screen is a named region rather than an anonymous stack of
 * cards a screen-reader user has to read through in order.
 */
function Group({ id, title, children, className }: GroupProps) {
  return (
    <section aria-labelledby={id} {...(className === undefined ? {} : { className })}>
      <SectionHeader id={id} title={title} />
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Delivery progress
// ---------------------------------------------------------------------------

/**
 * `done` is behind us, `current` is where the order stands, `pending` has not
 * happened. Only `current` gets the progress tint — the same colour the status
 * badge uses for an order in flight.
 */
type StepState = "done" | "current" | "pending";

const STEP_BAR: Readonly<Record<StepState, string>> = {
  done: "bg-[var(--success)]",
  current: "bg-[var(--progress)]",
  pending: "bg-[var(--fill-tertiary)]",
};

const STEP_LABEL: Readonly<Record<StepState, string>> = {
  done: "text-[var(--label)]",
  current: "text-[var(--progress-text)]",
  pending: "text-[var(--label-tertiary)]",
};

interface DeliveryStep {
  readonly key: string;
  /** Already translated. */
  readonly label: string;
  /** ISO timestamp, or null while the step has not happened. */
  readonly at: string | null;
}

/**
 * Earliest or latest of a set of timestamps, or null when the set is empty.
 *
 * `Date.parse` rather than a string comparison: `isoDateTimeSchema` accepts an
 * offset, and "2026-03-03T09:00:00+02:00" sorts after "2026-03-03T08:00:00Z"
 * lexicographically while being the earlier instant.
 */
function pickInstant(values: readonly string[], keep: "earliest" | "latest"): string | null {
  return values.reduce<string | null>((best, value) => {
    if (best === null) {
      return value;
    }
    const wins =
      keep === "earliest"
        ? Date.parse(value) < Date.parse(best)
        : Date.parse(value) > Date.parse(best);
    return wins ? value : best;
  }, null);
}

/**
 * The four milestones, each mapped to a field that EXISTS.
 *
 * There is no "expected delivery" step, drawn though it is: `shipmentSchema`
 * carries no estimate, and a date invented in the view is a promise the
 * platform never made. Shipped is the FIRST parcel to leave, delivered the last
 * one to arrive and only once every parcel has — a two-parcel order is not
 * delivered because half of it is.
 */
function deliverySteps(
  order: Order,
  shipments: readonly OrderShipment[],
  label: (step: "Placed" | "Paid" | "Shipped" | "Delivered") => string,
): readonly DeliveryStep[] {
  const shippedAt = shipments
    .map((shipment) => shipment.shippedAt)
    .filter((value): value is string => value !== null);
  const deliveredAt = shipments
    .map((shipment) => shipment.deliveredAt)
    .filter((value): value is string => value !== null);
  const allDelivered = shipments.length > 0 && deliveredAt.length === shipments.length;

  return [
    { key: "placed", label: label("Placed"), at: order.placedAt },
    { key: "paid", label: label("Paid"), at: order.paidAt },
    { key: "shipped", label: label("Shipped"), at: pickInstant(shippedAt, "earliest") },
    {
      key: "delivered",
      label: label("Delivered"),
      at: allDelivered ? pickInstant(deliveredAt, "latest") : null,
    },
  ];
}

interface DeliveryProgressProps {
  readonly order: Order;
  readonly shipments: readonly OrderShipment[];
}

/**
 * Four equal bars: where the order is, at a glance.
 *
 * Inline rather than a `ui/` primitive because it has exactly one consumer and
 * the repo rule is not to create a component used once — the shape is four
 * `--r-check` bars in a grid, not a mechanism worth exporting.
 *
 * A CANCELLED or FAILED order does not draw it: nothing further will ship, so a
 * rail with two grey steps still to come would read as an order still on its
 * way. Those two states say what happened through the status badge instead.
 */
function DeliveryProgress({ order, shipments }: DeliveryProgressProps) {
  const t = useTranslations("account.orderDetail");

  if (order.status === "CANCELLED" || order.status === "FAILED") {
    return null;
  }

  const steps = deliverySteps(order, shipments, (step) => t(`timeline${step}`));
  // The last step that has actually happened. Everything before it is done;
  // everything after is pending.
  const reached = steps.reduce((last, step, index) => (step.at === null ? last : index), 0);

  return (
    <Group id="order-timeline-heading" title={t("timelineTitle")}>
      <Card>
        {/* Two columns on a phone: four columns of "Pago confirmado" at 400px
            wraps every label onto three lines. */}
        <ol className="m-0 grid list-none grid-cols-2 gap-x-4 gap-y-4 p-0 sm:grid-cols-4">
          {steps.map((step, index) => {
            const state: StepState =
              // A step with no timestamp is pending even when a LATER one has
              // happened — an order paid by bank transfer after it shipped
              // must not paint "Pago confirmado" green with nothing behind it.
              step.at === null
                ? "pending"
                : // Only the leading edge is "current", and only while there is
                  // still somewhere to go: a fully delivered order is four
                  // completed steps, not three plus one in progress.
                  index === reached && reached < steps.length - 1
                  ? "current"
                  : "done";
            const current = state === "current" ? "step" : undefined;

            return (
              <li
                key={step.key}
                className="grid gap-2"
                {...(current === undefined ? {} : { "aria-current": current })}
              >
                {/* The bar repeats what the label and the timestamp already
                    say, so it is hidden rather than announced twice. */}
                <span aria-hidden className={`h-1 rounded-[var(--r-check)] ${STEP_BAR[state]}`} />
                <span className={`text-[13px] font-semibold leading-[18px] ${STEP_LABEL[state]}`}>
                  {step.label}
                </span>
                <span className="text-[13px] leading-[18px] tabular-nums text-[var(--label-secondary)]">
                  {step.at === null ? (
                    t("timelinePending")
                  ) : (
                    <time dateTime={step.at}>{formatDateTime(step.at)}</time>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </Card>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

function ShipmentsSection({ shipments }: { readonly shipments: readonly OrderShipment[] }) {
  const t = useTranslations("account.orderDetail");

  if (shipments.length === 0) {
    return (
      <Group id="order-shipments-heading" title={t("shipmentsTitle")}>
        <Card>
          <p className="m-0 text-[15px] leading-5 text-[var(--label-secondary)]">
            {t("shipmentsEmpty")}
          </p>
        </Card>
      </Group>
    );
  }

  return (
    <Group id="order-shipments-heading" title={t("shipmentsTitle")}>
      {/* One order can ship as several parcels — tracking lives on the
          shipment, not the order, precisely so partial shipment is
          representable rather than approximated. `GroupedList` renders the
          <ul>/<li> those parcels have always been. */}
      <GroupedList id="order-shipments" labelledBy="order-shipments-heading">
        {shipments.map((shipment) => {
          const trackingUrl = shipment.trackingUrl;

          return (
            <ContentRow
              key={shipment.id}
              title={shipment.carrier}
              meta={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {shipment.trackingNumber === null ? null : (
                    <span>
                      {t("trackingNumber")}:{" "}
                      <span className="font-mono">{shipment.trackingNumber}</span>
                    </span>
                  )}
                  {shipment.deliveredAt !== null ? (
                    <time dateTime={shipment.deliveredAt}>
                      {t("deliveredOn", { date: formatDate(shipment.deliveredAt) })}
                    </time>
                  ) : shipment.shippedAt !== null ? (
                    <time dateTime={shipment.shippedAt}>
                      {t("shippedOn", { date: formatDate(shipment.shippedAt) })}
                    </time>
                  ) : null}
                </span>
              }
              aside={<StatusBadge domain="shipment" value={shipment.status} />}
              {...(trackingUrl === null
                ? {}
                : {
                    trailing: (
                      <a
                        href={trackingUrl}
                        target="_blank"
                        // Carrier sites are third party: never hand one
                        // `window.opener`, and never leak which order page the
                        // customer came from.
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-[var(--r-check)] text-[var(--accent)] no-underline hover:underline focus-visible:shadow-[0_0_0_4px_var(--focus-ring)] focus-visible:outline-none"
                      >
                        {t("trackShipment")}
                        <Icon name="arrow-up-right" size={14} />
                      </a>
                    ),
                  })}
            />
          );
        })}
      </GroupedList>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function OrderItemsSection({ order }: { readonly order: Order }) {
  const t = useTranslations("account.orderDetail");

  return (
    <Group id="order-items-heading" title={t("itemsTitle")}>
      <GroupedList id="order-items" labelledBy="order-items-heading">
        {order.items.map((item) => (
          <OrderItemRow key={item.id} item={item} currency={order.currency} />
        ))}
      </GroupedList>
    </Group>
  );
}

interface OrderItemRowProps {
  readonly item: OrderItem;
  readonly currency: CurrencyCode;
}

function OrderItemRow({ item, currency }: OrderItemRowProps) {
  const t = useTranslations("account.orderDetail");

  return (
    <ContentRow
      title={
        <>
          {item.productName}
          {item.variantName === null ? null : (
            <>
              {" "}
              <span className="font-normal text-[var(--label-secondary)]">{item.variantName}</span>
            </>
          )}
        </>
      }
      meta={<span className="font-mono">{t("sku", { sku: item.sku })}</span>}
      trailing={
        <span className="grid justify-items-end gap-0.5">
          <Money amount={item.lineTotalGross} currency={currency} emphasis />
          {/* Quantity and unit price under the line total: at ×1 they say the
              same thing twice, but at ×2 the line total alone leaves the
              customer to divide, and this is the screen they came to check. */}
          <span className="text-[13px] leading-[18px]">
            {t("quantity", { quantity: item.quantity })}{" · "}
            <Money amount={item.unitPriceGross} currency={currency} />
          </span>
        </span>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

function OrderTotalsSection({ order }: { readonly order: Order }) {
  const t = useTranslations("account.orderDetail");

  return (
    <Group id="order-totals-heading" title={t("totalsTitle")}>
      <Card>
        {/* Discount and refund are passed unconditionally and `TotalsList`
            drops them at zero — the rule it owns, for the reason this screen
            had encoded by hand: a "−0,00 €" line beside "Descuento" makes a
            customer hunt for money they never lost. Shipping is NOT dropped at
            zero, because "Envío 0,00 €" is the good news that delivery was
            free. */}
        <TotalsList
          currency={order.currency}
          subtotal={{ label: t("subtotal"), amount: order.subtotal }}
          discount={{ label: t("discount"), amount: order.discountTotal }}
          shipping={{ label: t("shipping"), amount: order.shippingTotal }}
          taxIncluded={{ label: t("tax"), amount: order.taxTotal }}
          total={{ label: t("grandTotal"), amount: order.grandTotal }}
          refunded={{ label: t("refunded"), amount: order.refundedTotal }}
        />
      </Card>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

interface PaymentSectionProps {
  readonly order: Order;
  readonly payment: OrderDetail["payment"];
}

function PaymentSection({ order, payment }: PaymentSectionProps) {
  const t = useTranslations("account.orderDetail");

  return (
    // `grid-rows-[auto_1fr]`: the two-up row stretches this section, and the
    // card can only fill it if the section actually hands it a sized row —
    // `h-full` against an auto-height parent resolves to auto.
    <Group id="order-payment-heading" title={t("paymentTitle")} className="grid grid-rows-[auto_1fr]">
      <Card className="h-full">
        {payment === null ? (
          // No payment record. The ORDER status still tells the customer where
          // they stand, and "awaiting payment" is the one case where saying
          // nothing would read as a failed purchase.
          <p className="m-0 text-[15px] leading-5 text-[var(--label-secondary)]">
            {order.status === "PENDING" || order.status === "AWAITING_PAYMENT"
              ? t("paymentPending")
              : order.status === "FAILED"
                ? t("paymentFailed")
                : t("paymentNone")}
          </p>
        ) : (
          <div className="grid justify-items-start gap-2">
            <StatusBadge domain="payment" value={payment.status} />

            {payment.cardBrand === null || payment.cardLast4 === null ? null : (
              <p className="m-0 text-[15px] leading-5 text-[var(--label)]">
                {t("paymentCard", { brand: payment.cardBrand, last4: payment.cardLast4 })}
              </p>
            )}

            {payment.capturedAt === null ? null : (
              <p className="m-0 text-[13px] leading-[18px] text-[var(--label-secondary)]">
                <time dateTime={payment.capturedAt}>
                  {formatDateTime(payment.capturedAt)}
                </time>
              </p>
            )}

            {/* `payment.failureMessage` is deliberately NOT rendered. It is the
                provider's own prose, written in English for a log, and this
                screen belongs to a customer reading Spanish. The badge already
                says the attempt failed in their language, and `failureCode` is
                an open string rather than an enum, so there is nothing here to
                branch a translated explanation on. */}
          </div>
        )}
      </Card>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

function InvoiceSection({ order }: { readonly order: Order }) {
  const t = useTranslations("account.orderDetail");
  const tDocument = useTranslations("documents");

  return (
    <Group id="order-invoice-heading" title={t("invoiceTitle")} className="grid grid-rows-[auto_1fr]">
      <Card className="h-full">
        {/* Invoice numbers come from a gap-free sequence allocated at PAID only,
            so a null number is the normal state of an unpaid order, not an
            error. There is no download beside it: the invoices module is an
            empty `@Module({})` and dead-letters its own PDF job, so a button
            here would be a link to nothing. */}
        {order.invoiceNumber === null ? (
          <p className="m-0 text-[15px] leading-5 text-[var(--label-secondary)]">
            {t("invoicePending")}
          </p>
        ) : (
          <p className="m-0 font-mono text-[14px] leading-5 font-medium text-[var(--label)]">
            {t("invoiceNumber", { number: order.invoiceNumber })}
          </p>
        )}
        {/* The identity document given at checkout: what the invoice is
            issued to, and what a payment provider identified the buyer by. */}
        <p className="m-0 mt-2 text-[13px] leading-5 text-[var(--label-secondary)]">
          {t("document", {
            type: tDocument(`types.${order.documentType}`),
            number: order.documentNumber,
          })}
        </p>
      </Card>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

type AddressReader = (address: AddressFields) => string | null;

/**
 * Every field of `addressFieldsSchema`, as an accessor.
 *
 * The `Record` over `keyof AddressFields` is the point: a field added to the
 * contract is a COMPILE error here rather than a silent "same as the shipping
 * address" printed over two addresses that differ in the new field.
 */
const ADDRESS_READERS: Readonly<Record<keyof AddressFields, AddressReader>> = {
  firstName: (address) => address.firstName,
  lastName: (address) => address.lastName,
  company: (address) => address.company,
  line1: (address) => address.line1,
  line2: (address) => address.line2,
  city: (address) => address.city,
  region: (address) => address.region,
  postalCode: (address) => address.postalCode,
  countryCode: (address) => address.countryCode,
  phone: (address) => address.phone,
};

function sameAddress(a: AddressFields, b: AddressFields): boolean {
  return Object.values(ADDRESS_READERS).every((read) => read(a) === read(b));
}

function AddressesSection({ order }: { readonly order: Order }) {
  const t = useTranslations("account.orderDetail");
  const billingIsShipping = sameAddress(order.billingAddress, order.shippingAddress);

  return (
    <Group id="order-addresses-heading" title={t("addressesTitle")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid grid-rows-[auto_1fr]">
          <SectionHeader
            id="order-shipping-address-heading"
            as="h3"
            title={t("shippingAddress")}
          />
          <Card className="h-full">
            <AddressBlock address={order.shippingAddress} />
          </Card>
        </div>

        <div className="grid grid-rows-[auto_1fr]">
          <SectionHeader id="order-billing-address-heading" as="h3" title={t("billingAddress")} />
          <Card className="h-full">
            {/* Most orders bill where they ship. Printing the same six lines
                twice invites the customer to compare them character by
                character to find the difference there isn't one of. */}
            {billingIsShipping ? (
              <p className="m-0 text-[15px] leading-[1.45] text-[var(--label-secondary)]">
                {t("billingSameAsShipping")}
              </p>
            ) : (
              <AddressBlock address={order.billingAddress} />
            )}
          </Card>
        </div>
      </div>
    </Group>
  );
}

/**
 * A snapshotted address, one line per populated field.
 *
 * Null and blank lines are filtered rather than rendered: `company`, `line2`
 * and `postalCode` are legitimately empty on most Colombian addresses, and an
 * empty `<span className="block">` leaves a visible gap in the middle of
 * someone's own address. Colombian order: street line, then "city,
 * departamento", then the postal code when there is one.
 *
 * Exported because the account overview and the address book render the same
 * block; it lives here because this is where the snapshot rules are written
 * down.
 */
export function AddressBlock({ address }: { readonly address: AddressFields }) {
  const lines: readonly (string | null)[] = [
    `${address.firstName} ${address.lastName}`,
    address.company,
    address.line1,
    address.line2,
    `${address.city}, ${address.region}`,
    address.postalCode,
    address.countryCode,
  ];

  return (
    <address className="text-[15px] leading-[1.45] not-italic text-[var(--label-secondary)]">
      {lines
        .filter((line): line is string => line !== null && line.trim().length > 0)
        .map((line, index) => (
          <span key={`${line}-${index}`} className="block">
            {line}
          </span>
        ))}
    </address>
  );
}
