"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { AdminOrderShipment, BulkLabelResult, CancelLabelResult, Locale } from "@akai/contracts";

import { Button, buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmActionError, ConfirmAlert } from "@/components/ui/confirm";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/components/account/format";
import { useRouter } from "@/i18n/navigation";
import type { ActionResult } from "@/lib/admin/actions";
import { cancelLabelAction, generateLabelsAction, retryLabelAction } from "@/lib/admin/actions";
import {
  SKIP_REASON_KEY,
  canCancelLabel,
  canRetryLabel,
  labelFailureKey,
} from "@/lib/admin/fulfilment-display";

/** The three server actions, injectable for tests. */
export interface OrderShipmentHandlers {
  readonly generate: (
    orderIds: readonly string[],
    idempotencyKey: string,
  ) => Promise<ActionResult<BulkLabelResult>>;
  readonly cancel: (
    shipmentId: string,
    orderNumber: string,
    idempotencyKey: string,
  ) => Promise<ActionResult<CancelLabelResult>>;
  readonly retry: (
    shipmentId: string,
    orderNumber: string,
    idempotencyKey: string,
  ) => Promise<ActionResult<BulkLabelResult>>;
}

const DEFAULT_HANDLERS: OrderShipmentHandlers = {
  generate: generateLabelsAction,
  cancel: cancelLabelAction,
  retry: retryLabelAction,
};

export interface OrderShipmentsProps {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly locale: Locale;
  /** Oldest first, as the API sends them. */
  readonly shipments: readonly AdminOrderShipment[];
  /** `canGenerateLabel(order)` — computed by the page, which holds the whole order. */
  readonly canGenerate: boolean;
  readonly handlers?: OrderShipmentHandlers;
}

/**
 * The order's parcels, and the label actions on them (Sendcloud spec §3.6, §7).
 *
 * Every mutation ends in `router.refresh()`, so the card re-renders from the
 * API rather than guessing: a cancel that moved the order back to PAID, or a
 * label job that finished meanwhile, shows up as the server now sees it.
 *
 * `failureReason` is Sendcloud's own text, and it IS rendered — here only,
 * visibly marked staff-only, because it is the one thing that tells an
 * operator what to fix ("House number is required"). It never reaches a
 * customer DTO (the contract keeps it off `orderShipmentSchema`).
 */
export function OrderShipments({
  orderId,
  orderNumber,
  locale,
  shipments,
  canGenerate,
  handlers = DEFAULT_HANDLERS,
}: OrderShipmentsProps) {
  const t = useTranslations("admin.fulfilment");
  const tRoot = useTranslations();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<AdminOrderShipment | null>(null);
  /** One key per pending action, reused if the same action is retried after a failure. */
  const keys = useRef(new Map<string, string>());

  function keyFor(action: string): string {
    const existing = keys.current.get(action);
    if (existing !== undefined) return existing;
    const created = crypto.randomUUID();
    keys.current.set(action, created);
    return created;
  }

  function settled(action: string): void {
    keys.current.delete(action);
  }

  function skippedMessage(result: BulkLabelResult): string | null {
    const [first] = result.skipped;
    return first === undefined ? null : tRoot(SKIP_REASON_KEY[first.reason]);
  }

  async function onGenerate(): Promise<void> {
    const action = "generate";
    setBusy(action);
    try {
      const result = await handlers.generate([orderId], keyFor(action));
      if (!result.ok) {
        toast.show({ tone: "danger", message: tRoot(labelFailureKey(result.code, result.reason)) });
        return;
      }
      settled(action);
      const skipped = skippedMessage(result.data);
      toast.show(
        skipped === null
          ? { tone: "success", message: t("generateQueued") }
          : { tone: "warning", message: skipped },
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function onRetry(shipment: AdminOrderShipment): Promise<void> {
    const action = `retry:${shipment.id}`;
    setBusy(action);
    try {
      const result = await handlers.retry(shipment.id, orderNumber, keyFor(action));
      if (!result.ok) {
        toast.show({ tone: "danger", message: tRoot(labelFailureKey(result.code, result.reason)) });
        return;
      }
      settled(action);
      const skipped = skippedMessage(result.data);
      toast.show(
        skipped === null
          ? { tone: "success", message: t("retryQueued") }
          : { tone: "warning", message: skipped },
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function onConfirmCancel(): Promise<void> {
    if (cancelTarget === null) return;
    const action = `cancel:${cancelTarget.id}`;
    const result = await handlers.cancel(cancelTarget.id, orderNumber, keyFor(action));
    if (!result.ok) {
      // Keeps the dialog open with OUR sentence for the reason — never the API's.
      throw new ConfirmActionError(tRoot(labelFailureKey(result.code, result.reason)));
    }
    settled(action);
    toast.show({ tone: "success", message: t("cancelled") });
    router.refresh();
  }

  const downloadHref = (shipment: AdminOrderShipment): string =>
    `/api/admin/shipments/${shipment.id}/label?${new URLSearchParams({ order: orderNumber, locale }).toString()}`;

  return (
    <Card
      title={t("shipments.title")}
      titleId="order-shipments-heading"
      titleAs="h2"
      {...(canGenerate
        ? {
            action: (
              <Button
                icon="tag"
                variant="prominent"
                pending={busy === "generate"}
                pendingLabel={t("shipments.generatingOne")}
                onClick={() => {
                  void onGenerate();
                }}
              >
                {t("shipments.generate")}
              </Button>
            ),
          }
        : {})}
    >
      {shipments.length === 0 ? (
        <p className="m-0 text-[13px] text-[var(--label-secondary)]">{t("shipments.empty")}</p>
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
                <span className="text-[12px] text-[var(--label-secondary)]">
                  {t(`shipments.provider.${shipment.provider}`)}
                </span>
                {shipment.createdAt === null ? null : (
                  <time
                    dateTime={shipment.createdAt}
                    className="ms-auto text-[12px] text-[var(--label-secondary)] tabular-nums"
                  >
                    {t("shipments.created", { date: formatDateTime(shipment.createdAt, locale) })}
                  </time>
                )}
              </div>

              <p className="m-0 text-[13px]">
                <span className="text-[var(--label-secondary)]">{t("shipments.tracking")}: </span>
                {shipment.trackingNumber === null ? (
                  <span className="text-[var(--label-secondary)]">{t("shipments.noTracking")}</span>
                ) : shipment.trackingUrl === null ? (
                  <span className="font-mono text-[12px]">{shipment.trackingNumber}</span>
                ) : (
                  <a
                    href={shipment.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("shipments.trackingLink", { trackingNumber: shipment.trackingNumber })}
                    className="font-mono text-[12px] text-[var(--accent)] hover:underline"
                  >
                    {shipment.trackingNumber}
                  </a>
                )}
              </p>

              {shipment.providerStatusCode === null ? null : (
                <p className="m-0 font-mono text-[11px] text-[var(--label-secondary)]">
                  {t("shipments.providerStatus", { code: shipment.providerStatusCode })}
                </p>
              )}

              {shipment.failureReason === null ? null : (
                <div
                  data-testid="failure-reason"
                  className="rounded-[var(--r-check)] bg-[var(--warning-fill)] px-2.5 py-2 text-[12px]"
                >
                  <p className="m-0 font-semibold">{t("shipments.failureTitle")}</p>
                  <p className="m-0 mt-0.5 break-words">{shipment.failureReason}</p>
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2">
                {shipment.hasLabel ? (
                  <a
                    href={downloadHref(shipment)}
                    target="_blank"
                    rel="noopener"
                    className={buttonClassName({ variant: "standard" })}
                  >
                    {t("shipments.download")}
                  </a>
                ) : null}
                {canCancelLabel(shipment) ? (
                  <Button
                    variant="destructivePlain"
                    onClick={() => {
                      setCancelTarget(shipment);
                    }}
                  >
                    {t("shipments.cancel")}
                  </Button>
                ) : null}
                {canRetryLabel(shipment) ? (
                  <Button
                    pending={busy === `retry:${shipment.id}`}
                    pendingLabel={t("shipments.retrying")}
                    onClick={() => {
                      void onRetry(shipment);
                    }}
                  >
                    {t("shipments.retry")}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmAlert
        open={cancelTarget !== null}
        onClose={() => {
          setCancelTarget(null);
        }}
        title={t("cancelDialog.title")}
        item={
          cancelTarget === null
            ? orderNumber
            : `${orderNumber} · ${cancelTarget.carrier}${
                cancelTarget.trackingNumber === null ? "" : ` · ${cancelTarget.trackingNumber}`
              }`
        }
        consequence={t("cancelDialog.consequence")}
        icon="tag"
        confirmLabel={t("cancelDialog.confirm")}
        cancelLabel={t("cancelDialog.keep")}
        busyLabel={t("cancelDialog.busy")}
        fallbackError={tRoot("errors.generic")}
        onConfirm={onConfirmCancel}
      />
    </Card>
  );
}
