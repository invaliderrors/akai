"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { AdminOrderShipment, CreateShipment, ShipmentStatus } from "@akai/contracts";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TextField } from "@/components/ui/field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/components/account/format";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/admin/actions";
import { createShipmentAction, markShipmentDeliveredAction } from "@/lib/admin/actions";
import { canMarkDelivered, type UnshippedLine } from "@/lib/admin/shipment-display";

/** The two server actions, injectable for tests. */
export interface OrderShipmentHandlers {
  readonly create: (
    orderNumber: string,
    input: CreateShipment,
  ) => Promise<ActionResult<{ shipmentId: string }>>;
  readonly deliver: (
    shipmentId: string,
    orderNumber: string,
  ) => Promise<ActionResult<{ status: ShipmentStatus }>>;
}

const DEFAULT_HANDLERS: OrderShipmentHandlers = {
  create: createShipmentAction,
  deliver: markShipmentDeliveredAction,
};

export interface OrderShipmentsProps {
  readonly orderNumber: string;
  /** Oldest first, as the API sends them. */
  readonly shipments: readonly AdminOrderShipment[];
  /**
   * The lines a new parcel would carry (`unshippedLines(order)`), or empty when
   * no shipment may be recorded — computed by the page, which holds the order.
   */
  readonly toShip: readonly UnshippedLine[];
  readonly handlers?: OrderShipmentHandlers;
}

/**
 * The order's parcels, shipped BY HAND: staff type the carrier
 * ("Servientrega", "Coordinadora", "Interrapidísimo"…) and the tracking number
 * as free text, then mark the parcel delivered when it arrives. There is no
 * carrier integration; the API walks the order PAID → FULFILLING → SHIPPED on
 * the parcel and SHIPPED → DELIVERED once every parcel is delivered, and mails
 * the customer each time.
 *
 * Every mutation ends in `router.refresh()`, so the card re-renders from the
 * API rather than guessing.
 */
export function OrderShipments({
  orderNumber,
  shipments,
  toShip,
  handlers = DEFAULT_HANDLERS,
}: OrderShipmentsProps) {
  const t = useTranslations("admin.fulfilment.shipments");
  const tRoot = useTranslations();
  const toast = useToast();
  const router = useRouter();
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrierError, setCarrierError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);

  function failureMessage(code: string | null): string {
    return code === null || code === "UNPARSEABLE_RESPONSE"
      ? tRoot("errors.generic")
      : tRoot(`errors.${code}`);
  }

  async function onRecord(): Promise<void> {
    const trimmedCarrier = carrier.trim();
    if (trimmedCarrier === "") {
      setCarrierError(t("carrierRequired"));
      return;
    }
    setCarrierError(undefined);
    setBusy("record");
    try {
      const trimmedTracking = trackingNumber.trim();
      const result = await handlers.create(orderNumber, {
        carrier: trimmedCarrier,
        trackingNumber: trimmedTracking === "" ? null : trimmedTracking,
        items: toShip.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity })),
      });
      if (!result.ok) {
        toast.show({ tone: "danger", message: failureMessage(result.code) });
        return;
      }
      setCarrier("");
      setTrackingNumber("");
      toast.show({ tone: "success", message: t("recorded") });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function onDeliver(shipment: AdminOrderShipment): Promise<void> {
    const action = `deliver:${shipment.id}`;
    setBusy(action);
    try {
      const result = await handlers.deliver(shipment.id, orderNumber);
      if (!result.ok) {
        toast.show({ tone: "danger", message: failureMessage(result.code) });
        return;
      }
      toast.show({ tone: "success", message: t("delivered") });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title={t("title")} titleId="order-shipments-heading" titleAs="h2">
      {shipments.length === 0 ? (
        <p className="m-0 text-[13px] text-[var(--label-secondary)]">{t("empty")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0" aria-labelledby="order-shipments-heading">
          {[...shipments].reverse().map((shipment) => (
            <li
              key={shipment.id}
              data-testid="shipment-card"
              className="grid gap-2 rounded-[var(--r-check)] bg-[var(--bg-grouped)] p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge domain="shipment" value={shipment.status} density="compact" />
                <span className="text-[13px] font-semibold text-[var(--label)]">{shipment.carrier}</span>
                <time
                  dateTime={shipment.createdAt}
                  className="ms-auto text-[12px] text-[var(--label-secondary)] tabular-nums"
                >
                  {t("created", { date: formatDateTime(shipment.createdAt) })}
                </time>
              </div>

              <p className="m-0 text-[13px]">
                <span className="text-[var(--label-secondary)]">{t("tracking")}: </span>
                {shipment.trackingNumber === null ? (
                  <span className="text-[var(--label-secondary)]">{t("noTracking")}</span>
                ) : shipment.trackingUrl === null ? (
                  <span className="font-mono text-[12px]">{shipment.trackingNumber}</span>
                ) : (
                  <a
                    href={shipment.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("trackingLink", { trackingNumber: shipment.trackingNumber })}
                    className="font-mono text-[12px] text-[var(--accent)] hover:underline"
                  >
                    {shipment.trackingNumber}
                  </a>
                )}
              </p>

              {canMarkDelivered(shipment) ? (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    pending={busy === `deliver:${shipment.id}`}
                    pendingLabel={t("markingDelivered")}
                    onClick={() => {
                      void onDeliver(shipment);
                    }}
                  >
                    {t("markDelivered")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {toShip.length === 0 ? null : (
        <form
          noValidate
          aria-labelledby="order-record-shipment-heading"
          className="mt-4 grid gap-3 border-t border-[var(--separator-weak)] pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onRecord();
          }}
        >
          <h3
            id="order-record-shipment-heading"
            className="m-0 text-[13px] font-semibold text-[var(--label)]"
          >
            {t("record")}
          </h3>
          <p className="m-0 text-[12px] text-[var(--label-secondary)]">{t("recordHint")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label={t("carrier")}
              name="carrier"
              value={carrier}
              onChange={setCarrier}
              placeholder={t("carrierPlaceholder")}
              maxLength={64}
              required
              {...(carrierError === undefined ? {} : { error: carrierError })}
            />
            <TextField
              label={t("trackingNumber")}
              name="trackingNumber"
              value={trackingNumber}
              onChange={setTrackingNumber}
              maxLength={128}
              mono
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="prominent"
              icon="tag"
              pending={busy === "record"}
              pendingLabel={t("recording")}
            >
              {t("submit")}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
