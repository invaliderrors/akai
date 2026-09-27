"use client";

import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";

import type { CurrencyCode, Minor } from "@akai/contracts";

import type { RequestReturnResult } from "@/app/[locale]/(customer)/returns/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PopupButton, TextArea } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { EmptyState } from "@/components/ui/states";

import { asLocale, formatAmount, formatDate } from "./format";

/**
 * "Request a return".
 *
 * IT IS A WHOLE-ORDER FORM, AND THAT IS THE CONTRACT, not a simplification.
 * `createReturnRequestSchema` is `.strict()` and carries exactly
 * `{ orderNumber, reason }`, so there is no item picker, no quantity stepper,
 * no reason enum and no estimated refund to render: a body carrying an `items`
 * array is rejected at the API boundary with a 400 before any handler sees it.
 * `libs/contracts/src/lib/returns.ts` states the model and why.
 *
 * `"use client"` because all three of the things this screen does are client
 * state: the picker and the reason are controlled, the submit has three
 * outcomes (accepted / refused / never arrived), and only one of them may be on
 * screen at a time.
 *
 * IT BRANCHES ON A TRANSLATION KEY, NEVER ON A SERVER MESSAGE. The API's prose
 * is English written for a log; the customer gets copy in their own language.
 * The key arrives as a bare `string` from the server action, so it is narrowed
 * against a closed list here rather than interpolated into `t()` — an unknown
 * key would otherwise render the key path itself in front of a customer.
 */

/**
 * The narrowed order the picker needs, and nothing else.
 *
 * NOT `OrderSummary`. The page derives this set server-side and hands over four
 * fields; passing the wide row would ship `id`, `status` and `itemCount` across
 * the boundary for a control that renders one line of text per option.
 */
export interface EligibleOrder {
  /** The ORDER NUMBER, not the id: it is the only reference the contract accepts. */
  readonly orderNumber: string;
  readonly placedAt: string;
  readonly grandTotal: Minor;
  readonly currency: CurrencyCode;
}

/**
 * Every key the server action can hand back, as a closed list.
 *
 * `RequestReturnResult.errorKey` is typed `string`, so the totality has to be
 * earned here: `ERROR_MESSAGE` is a `Record` over this union, which makes a new
 * member a COMPILE error rather than a blank alert, and `toErrorKey` collapses
 * anything unrecognised to `generic` rather than letting a key path reach the
 * page.
 */
const ERROR_KEYS = [
  "notFound",
  "notDelivered",
  "alreadyOpen",
  "rateLimited",
  "invalid",
  "generic",
] as const;

type ReturnErrorKey = (typeof ERROR_KEYS)[number];

const ERROR_MESSAGE: Readonly<Record<ReturnErrorKey, string>> = {
  notFound: "errors.notFound",
  notDelivered: "errors.notDelivered",
  alreadyOpen: "errors.alreadyOpen",
  rateLimited: "errors.rateLimited",
  invalid: "errors.invalid",
  generic: "errors.generic",
};

function toErrorKey(value: string): ReturnErrorKey {
  return ERROR_KEYS.find((candidate) => candidate === value) ?? "generic";
}

/** Mirrors `createReturnRequestSchema.reason` — `z.string().min(1).max(500)`. */
const REASON_MAX = 500;

export interface ReturnRequestFormProps {
  /**
   * Already filtered by the page. Empty is a legitimate state with its own
   * rendering, NOT a disabled picker: a select with nothing in it tells a
   * customer their account is broken, where the empty state tells them what the
   * window is.
   */
  readonly orders: readonly EligibleOrder[];
  readonly onSubmit: (formData: FormData) => Promise<RequestReturnResult>;
}

export function ReturnRequestForm({ orders, onSubmit }: ReturnRequestFormProps) {
  const t = useTranslations("account.returns");
  const locale = asLocale(useLocale());

  // `orders[0]` is `EligibleOrder | undefined` under `noUncheckedIndexedAccess`.
  // Pre-selecting the first is what a pop-up button does — it always carries a
  // selection — and it also means the empty string below is only ever the value
  // of a form that is never rendered.
  const [orderNumber, setOrderNumber] = useState(orders[0]?.orderNumber ?? "");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const [errorKey, setErrorKey] = useState<ReturnErrorKey | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    // `Button` already swallows the second press with `preventDefault`; this is
    // the same guarantee for a submit raised by the Enter key inside a field,
    // which never passes through the button's handler at all.
    if (busy) {
      return;
    }

    const trimmed = reason.trim();
    if (trimmed === "") {
      setReasonError(t("requiredReason"));
      return;
    }

    setReasonError(undefined);
    setBusy(true);
    setErrorKey(null);
    setDone(false);

    // Built here rather than read off the form, so what is sent is exactly the
    // two fields the strict request schema accepts and nothing a stray `name`
    // attribute added.
    const formData = new FormData();
    formData.set("orderNumber", orderNumber);
    formData.set("reason", trimmed);

    try {
      const result = await onSubmit(formData);
      if (result.ok) {
        setDone(true);
        // The request is filed; leaving the text in place invites a second,
        // duplicate submission of the same words.
        setReason("");
      } else {
        setErrorKey(toErrorKey(result.errorKey));
      }
    } catch {
      // A rejected action (network, a redeploy mid-submit) must not surface as
      // an unhandled rejection in the console with nothing on screen.
      setErrorKey("generic");
    } finally {
      setBusy(false);
    }
  }

  if (orders.length === 0) {
    return (
      <Card title={t("requestHeading")} titleAs="h2" titleId="return-request-heading">
        <EmptyState
          title={t("noEligibleTitle")}
          body={t("noEligibleBody")}
          icon="package"
        />
      </Card>
    );
  }

  return (
    <Card title={t("requestHeading")} titleAs="h2" titleId="return-request-heading">
      <p className="m-0 mb-[var(--card-p)] text-[13px] leading-[1.35] text-[var(--label-secondary)]">
        {t("policy")}
      </p>

      {/* `noValidate`: the messages below are translated and announced on the
          field that failed, which the browser's own bubble is neither. */}
      <form onSubmit={(event) => void handleSubmit(event)} noValidate className="grid gap-4">
        {/* `Notice` picks the live-region role from the tone — danger is
            `role="alert"`, success is `role="status"` — so a failure interrupts
            and a confirmation does not. */}
        {errorKey === null ? null : (
          <Notice tone="danger" placement="inline">
            {t(ERROR_MESSAGE[errorKey])}
          </Notice>
        )}
        {done ? (
          <Notice tone="success" placement="inline">
            {t("submitted")}
          </Notice>
        ) : null}

        <PopupButton
          label={t("orderPickerLabel")}
          name="orderNumber"
          value={orderNumber}
          onChange={setOrderNumber}
          required
          disabled={busy}
          // What the list ACTUALLY contains, and the API's own rule verbatim
          // (`RETURNABLE_ORDER_STATUSES = ["DELIVERED"]`). The 14-day window is
          // stated as policy above rather than claimed of this list — see the
          // page for why it cannot be computed from the order projection.
          hint={t("eligibility")}
          options={orders.map((order) => ({
            value: order.orderNumber,
            // An `<option>` holds text and nothing else, so the amount is
            // formatted through `@akai/money` into the string rather than
            // rendered by `ui/money`.
            label: t("orderOption", {
              orderNumber: order.orderNumber,
              date: formatDate(order.placedAt, locale),
              total: formatAmount(order.grandTotal, order.currency, locale),
            }),
          }))}
        />

        <TextArea
          label={t("reasonLabel")}
          name="reason"
          value={reason}
          onChange={(value) => {
            setReason(value);
            // Clear the complaint the moment the customer answers it; leaving
            // "tell us the reason" under a filled box is a lie about the form.
            setReasonError(undefined);
            setDone(false);
          }}
          rows={4}
          maxLength={REASON_MAX}
          required
          disabled={busy}
          hint={t("reasonHint")}
          {...(reasonError === undefined ? {} : { error: reasonError })}
        />

        <div className="flex justify-end">
          <Button
            type="submit"
            variant="prominent"
            // 44px, matching `--control-h` in the comfortable customer shell:
            // the button and the field beside it are the same target height.
            size="mobile"
            pending={busy}
            pendingLabel={t("submitting")}
          >
            {t("submit")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
