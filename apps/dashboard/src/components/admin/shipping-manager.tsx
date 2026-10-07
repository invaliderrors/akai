"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  toMinor,
  type AdminShippingRate,
  type AdminShippingZoneDetail,
  } from "@akai/contracts";
import { formatMoney } from "@akai/money";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmActionError, ConfirmAlert } from "@/components/ui/confirm";
import { Notice } from "@/components/ui/notice";
import { EmptyState } from "@/components/ui/states";
import { DataTable, type Column } from "@/components/ui/table";
import type { ActionErrorCode, ActionResult } from "@/lib/admin/actions";
import type {
  CreateShippingRateInput,
  CreateShippingZoneInput,
  UpdateShippingRateInput,
  UpdateShippingZoneInput,
} from "@/lib/admin/shipping-api";
import {
  SHIPPING_CURRENCY,
  freeShippingMismatches,
  rateDisplayName,
  shippingFailureReason,
} from "@/lib/admin/shipping-form";

import { ShippingRateEditor } from "./shipping-rate-editor";
import { ShippingZoneEditor } from "./shipping-zone-editor";
import { TypeToConfirmButton } from "./type-to-confirm-button";

/**
 * `/admin/shipping` — every zone, its countries and its rates, all editable
 * ("fully editable in the dashboard"). Akai ships within Colombia only, so in
 * practice this is one zone with a rate or two.
 *
 * ONE SCREEN, THE CATEGORY-MANAGER SHAPE. A store has a handful of zones and a
 * few rates each, so the whole configuration fits on one page, and an operator
 * changing a price wants to see the zone it lives in while doing it. Like
 * `CategoryManager`, LOCAL STATE IS THE SOURCE OF TRUTH AFTER EVERY WRITE: each
 * action returns the saved row and this component patches `zones` with it,
 * rather than depending on a refresh of the server component that seeded it.
 *
 * NOTHING HERE RENDERS A SERVER MESSAGE. A failure is translated from the
 * envelope's `reason` (the closed `shippingAdminFailureReasonSchema`) when there
 * is one, from its `code` otherwise. A COUNTRY_IN_OTHER_ZONE refusal is named
 * with the zone list this page already holds, not with the API's English.
 */

export interface ShippingManagerProps {
  readonly initialZones: readonly AdminShippingZoneDetail[];
  /** ISO code → name in the operator's locale, computed on the server. */
  readonly countryNames: Readonly<Record<string, string>>;
  /** What the storefront copy promises, in minor units (`ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR`). */
  readonly advertisedThreshold: number;
  readonly onCreateZone: (input: CreateShippingZoneInput) => Promise<ActionResult<AdminShippingZoneDetail>>;
  readonly onUpdateZone: (
    zoneId: string,
    input: UpdateShippingZoneInput,
  ) => Promise<ActionResult<AdminShippingZoneDetail>>;
  readonly onDeleteZone: (zoneId: string) => Promise<ActionResult<null>>;
  readonly onCreateRate: (
    zoneId: string,
    input: CreateShippingRateInput,
  ) => Promise<ActionResult<AdminShippingRate>>;
  readonly onUpdateRate: (
    zoneId: string,
    rateId: string,
    input: UpdateShippingRateInput,
  ) => Promise<ActionResult<AdminShippingRate>>;
  readonly onDeleteRate: (zoneId: string, rateId: string) => Promise<ActionResult<null>>;
}

/**
 * `ActionErrorCode` → `admin.shipping.errors.*`, TOTAL over the union so a new
 * platform code is a compile error here. Local rather than imported from
 * `discount-editor`: that module's value import of the server actions would
 * drag them into every render of this one.
 */
const ACTION_ERROR_KEYS: Readonly<Record<ActionErrorCode, string>> = {
  VALIDATION_FAILED: "errors.VALIDATION_FAILED",
  UNAUTHENTICATED: "errors.UNAUTHENTICATED",
  FORBIDDEN: "errors.FORBIDDEN",
  NOT_FOUND: "errors.NOT_FOUND",
  CONFLICT: "errors.CONFLICT",
  IDEMPOTENCY_KEY_REUSED: "errors.IDEMPOTENCY_KEY_REUSED",
  RATE_LIMITED: "errors.RATE_LIMITED",
  PAYMENT_FAILED: "errors.PAYMENT_FAILED",
  OUT_OF_STOCK: "errors.OUT_OF_STOCK",
  PRICE_CHANGED: "errors.PRICE_CHANGED",
  ILLEGAL_STATE_TRANSITION: "errors.ILLEGAL_STATE_TRANSITION",
  INTERNAL_ERROR: "errors.INTERNAL_ERROR",
  UNPARSEABLE_RESPONSE: "errors.UNPARSEABLE_RESPONSE",
};

/** Which editor is open. One at a time: two open forms is two half-finished edits. */
type Editing =
  | { readonly kind: "none" }
  | { readonly kind: "newZone" }
  | { readonly kind: "zone"; readonly zoneId: string }
  | { readonly kind: "newRate"; readonly zoneId: string }
  | { readonly kind: "rate"; readonly zoneId: string; readonly rateId: string };

/** Rates in the order the API lists them: cheapest first. */
function sortRates(rates: readonly AdminShippingRate[]): AdminShippingRate[] {
  return [...rates].sort((a, b) => a.priceGross - b.priceGross || a.createdAt.localeCompare(b.createdAt));
}

function sortZones(zones: readonly AdminShippingZoneDetail[]): AdminShippingZoneDetail[] {
  return [...zones].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export function ShippingManager({
  initialZones,
  countryNames,
  advertisedThreshold,
  onCreateZone,
  onUpdateZone,
  onDeleteZone,
  onCreateRate,
  onUpdateRate,
  onDeleteRate,
}: ShippingManagerProps) {
  const t = useTranslations("admin.shipping");
  const [zones, setZones] = useState<readonly AdminShippingZoneDetail[]>(() => sortZones(initialZones));
  const [editing, setEditing] = useState<Editing>({ kind: "none" });
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const [pendingRateDelete, setPendingRateDelete] = useState<
    { readonly zoneId: string; readonly rate: AdminShippingRate } | undefined
  >(undefined);

  // `toMinor` re-validates: the advertised figure and the PRICE bounds arrive
  // as plain integers, and formatMoney only accepts a minted Minor.
  const money = (minor: number): string => formatMoney(toMinor(minor), SHIPPING_CURRENCY);

  /** A failure, translated: the domain reason when it has copy, the code otherwise. */
  function failureMessage(result: { readonly code: ActionErrorCode | null; readonly reason: string | null }): string {
    const reason = shippingFailureReason(result.reason);
    if (reason !== null) return t(`reasons.${reason}`);
    return t(result.code === null ? "errors.UNKNOWN" : ACTION_ERROR_KEYS[result.code]);
  }

  function replaceZone(zone: AdminShippingZoneDetail): void {
    setZones((current) => sortZones(current.map((entry) => (entry.id === zone.id ? zone : entry))));
  }

  function patchRates(zoneId: string, change: (rates: readonly AdminShippingRate[]) => AdminShippingRate[]): void {
    setZones((current) =>
      current.map((zone) => (zone.id === zoneId ? { ...zone, rates: change(zone.rates) } : zone)),
    );
  }

  function done(message: string): void {
    setEditing({ kind: "none" });
    setSaved(message);
  }

  const mismatches = freeShippingMismatches(zones, advertisedThreshold);

  function rateColumns(zone: AdminShippingZoneDetail): readonly Column<AdminShippingRate>[] {
    return [
      {
        key: "name",
        header: t("rate.colName"),
        cell: (rate) => rateDisplayName(rate) || t("rate.unnamed"),
      },
      {
        key: "rule",
        header: t("rate.colRule"),
        cell: (rate) => describeRule(rate),
      },
      {
        key: "price",
        header: t("rate.colPrice"),
        kind: "numeric",
        cell: (rate) => money(rate.priceGross),
      },
      {
        key: "freeOver",
        header: t("rate.colFreeOver"),
        kind: "numeric",
        cell: (rate) =>
          rate.freeOverSubtotal === null ? t("rate.noThreshold") : money(rate.freeOverSubtotal),
      },
      {
        key: "transit",
        header: t("rate.colTransit"),
        cell: (rate) => describeTransit(rate),
      },
      {
        key: "state",
        header: t("rate.colState"),
        cell: (rate, state) => (
          <Badge
            tone={rate.isActive ? "success" : "neutral"}
            label={rate.isActive ? t("rate.stateActive") : t("rate.stateInactive")}
            density="compact"
            onAccent={state.selected}
          />
        ),
      },
      {
        key: "actions",
        header: t("rate.colActions"),
        kind: "actions",
        cell: (rate) => (
          <span className="flex justify-end gap-1">
            <Button
              variant="plain"
              size="compact"
              onClick={() => {
                setSaved(undefined);
                setEditing({ kind: "rate", zoneId: zone.id, rateId: rate.id });
              }}
            >
              {t("rate.edit")}
            </Button>
            <Button
              variant="plain"
              size="compact"
              onClick={() => setPendingRateDelete({ zoneId: zone.id, rate })}
            >
              {t("rate.delete")}
            </Button>
          </span>
        ),
      },
    ];
  }

  function describeRule(rate: AdminShippingRate): string {
    if (rate.strategy === "FLAT") return t("rate.ruleFlat");
    const format = (value: number): string =>
      rate.strategy === "PRICE" ? money(value) : t("rate.grams", { grams: value });
    const kind = rate.strategy === "PRICE" ? "Price" : "Weight";
    if (rate.minValue !== null && rate.maxValue !== null) {
      return t(`rate.rule${kind}Between`, { min: format(rate.minValue), max: format(rate.maxValue) });
    }
    if (rate.minValue !== null) return t(`rate.rule${kind}From`, { min: format(rate.minValue) });
    if (rate.maxValue !== null) return t(`rate.rule${kind}Under`, { max: format(rate.maxValue) });
    return t(`rate.rule${kind}Any`);
  }

  function describeTransit(rate: AdminShippingRate): string {
    const { transitDaysMin: min, transitDaysMax: max } = rate;
    if (min === null && max === null) return "—";
    if (min !== null && max !== null) {
      return min === max ? t("rate.transitExact", { days: min }) : t("rate.transitRange", { min, max });
    }
    return t("rate.transitExact", { days: min ?? max ?? 0 });
  }

  return (
    <div className="grid gap-4">
      {mismatches.length === 0 ? null : (
        <Notice tone="warning" title={t("threshold.title")}>
          {t("threshold.body", { amount: money(advertisedThreshold), count: mismatches.length })}{" "}
          {mismatches
            .map((mismatch) =>
              t("threshold.row", {
                zone: mismatch.zoneName,
                rate: rateDisplayName(mismatch.rate) || t("rate.unnamed"),
                threshold:
                  mismatch.freeOverSubtotal === null
                    ? t("threshold.none")
                    : money(mismatch.freeOverSubtotal),
              }),
            )
            .join(" · ")}
        </Notice>
      )}

      {saved === undefined ? null : (
        <Notice tone="success" dismiss={{ label: t("dismiss"), onDismiss: () => setSaved(undefined) }}>
          {saved}
        </Notice>
      )}

      <div className="flex justify-end">
        <Button
          variant="prominent"
          size="compact"
          disabled={editing.kind === "newZone"}
          onClick={() => {
            setSaved(undefined);
            setEditing({ kind: "newZone" });
          }}
        >
          {t("zone.new")}
        </Button>
      </div>

      {editing.kind === "newZone" ? (
        <Card title={t("zone.createTitle")}>
          <ShippingZoneEditor
            zones={zones}
            countryNames={countryNames}
            onCancel={() => setEditing({ kind: "none" })}
            onSave={async (payload) => {
              const result = await onCreateZone(payload);
              if (!result.ok) return failureMessage(result);
              setZones((current) => sortZones([...current, result.data]));
              done(t("zone.created", { name: result.data.name }));
              return undefined;
            }}
          />
        </Card>
      ) : null}

      {zones.length === 0 ? (
        <EmptyState title={t("emptyTitle")} body={t("emptyBody")} reason="nothing-yet" />
      ) : (
        zones.map((zone) => (
          <Card
            key={zone.id}
            title={zone.name}
            titleId={`shipping-zone-${zone.id}`}
            action={
              <span className="flex gap-1">
                <Button
                  variant="standard"
                  size="compact"
                  onClick={() => {
                    setSaved(undefined);
                    setEditing({ kind: "zone", zoneId: zone.id });
                  }}
                >
                  {t("zone.edit")}
                </Button>
                <TypeToConfirmButton
                  phrase={zone.name}
                  triggerLabel={t("zone.deleteTrigger")}
                  title={t("zone.deleteTitle")}
                  body={t("zone.deleteBody", { count: zone.rates.length })}
                  prompt={t.rich("zone.deletePrompt", {
                    phrase: zone.name,
                    mono: (chunks) => <span className="font-mono font-semibold">{chunks}</span>,
                  })}
                  confirmLabel={t("zone.deleteConfirm")}
                  busyLabel={t("zone.deleteBusy")}
                  cancelLabel={t("cancel")}
                  fallbackError={t("errors.UNKNOWN")}
                  onConfirm={async () => {
                    const result = await onDeleteZone(zone.id);
                    if (!result.ok) throw new ConfirmActionError(failureMessage(result));
                    setZones((current) => current.filter((entry) => entry.id !== zone.id));
                    done(t("zone.deleted", { name: zone.name }));
                  }}
                />
              </span>
            }
          >
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {zone.countryCodes.length === 0 ? (
                  <span className="text-[12px] text-[var(--warning-text)]">{t("zone.noCountries")}</span>
                ) : (
                  zone.countryCodes.map((code) => (
                    <span
                      key={code}
                      title={countryNames[code] ?? code}
                      className="rounded-[var(--r-pill)] bg-[var(--fill-tertiary)] px-2 py-0.5 font-mono text-[11px] text-[var(--label)]"
                    >
                      {code}
                    </span>
                  ))
                )}
                <span className="ml-auto text-[12px] text-[var(--label-secondary)]">
                  {t("zone.summary", { count: zone.rates.length, sort: zone.sortOrder })}
                </span>
              </div>

              {editing.kind === "zone" && editing.zoneId === zone.id ? (
                <ShippingZoneEditor
                  zone={zone}
                  zones={zones}
                  countryNames={countryNames}
                  onCancel={() => setEditing({ kind: "none" })}
                  onSave={async (payload) => {
                    const result = await onUpdateZone(zone.id, payload);
                    if (!result.ok) return failureMessage(result);
                    replaceZone(result.data);
                    done(t("zone.saved", { name: result.data.name }));
                    return undefined;
                  }}
                />
              ) : null}

              <DataTable
                caption={t("rate.caption", { zone: zone.name })}
                columns={rateColumns(zone)}
                rows={zone.rates}
                rowKey={(rate) => rate.id}
                rowTone={(rate) =>
                  editing.kind === "rate" && editing.rateId === rate.id ? "selected" : "default"
                }
                frame={false}
                minWidth="none"
                empty={
                  <EmptyState
                    title={t("rate.emptyTitle")}
                    body={t("rate.emptyBody")}
                    reason="nothing-yet"
                    density="table"
                  />
                }
              />

              {editing.kind === "rate" && editing.zoneId === zone.id
                ? (() => {
                    const rate = zone.rates.find((entry) => entry.id === editing.rateId);
                    return rate === undefined ? null : (
                      <ShippingRateEditor
                        key={rate.id}
                        rate={rate}
                        onCancel={() => setEditing({ kind: "none" })}
                        onSave={async (payload) => {
                          const result = await onUpdateRate(zone.id, rate.id, payload);
                          if (!result.ok) return failureMessage(result);
                          patchRates(zone.id, (rates) =>
                            sortRates(rates.map((entry) => (entry.id === rate.id ? result.data : entry))),
                          );
                          done(t("rate.saved"));
                          return undefined;
                        }}
                      />
                    );
                  })()
                : null}

              {editing.kind === "newRate" && editing.zoneId === zone.id ? (
                <ShippingRateEditor
                  onCancel={() => setEditing({ kind: "none" })}
                  onSave={async (payload) => {
                    const result = await onCreateRate(zone.id, payload);
                    if (!result.ok) return failureMessage(result);
                    patchRates(zone.id, (rates) => sortRates([...rates, result.data]));
                    done(t("rate.created"));
                    return undefined;
                  }}
                />
              ) : (
                <div>
                  <Button
                    variant="standard"
                    size="compact"
                    onClick={() => {
                      setSaved(undefined);
                      setEditing({ kind: "newRate", zoneId: zone.id });
                    }}
                  >
                    {t("rate.add")}
                  </Button>
                </div>
              )}
            </div>
          </Card>
        ))
      )}

      <ConfirmAlert
        open={pendingRateDelete !== undefined}
        onClose={() => setPendingRateDelete(undefined)}
        title={t("rate.deleteTitle")}
        item={
          pendingRateDelete === undefined
            ? ""
            : rateDisplayName(pendingRateDelete.rate) || t("rate.unnamed")
        }
        consequence={t("rate.deleteBody")}
        confirmLabel={t("rate.deleteConfirm")}
        cancelLabel={t("cancel")}
        busyLabel={t("rate.deleteBusy")}
        fallbackError={t("errors.UNKNOWN")}
        density="compact"
        onConfirm={async () => {
          if (pendingRateDelete === undefined) return;
          const { zoneId, rate } = pendingRateDelete;
          const result = await onDeleteRate(zoneId, rate.id);
          if (!result.ok) throw new ConfirmActionError(failureMessage(result));
          patchRates(zoneId, (rates) => rates.filter((entry) => entry.id !== rate.id));
          setSaved(t("rate.deleted"));
        }}
      />
    </div>
  );
}
