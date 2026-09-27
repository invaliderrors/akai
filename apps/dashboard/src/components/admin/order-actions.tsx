"use client";

import type { CurrencyCode, Locale, Minor, OrderStatus } from "@akai/contracts";

import { useRouter } from "@/i18n/navigation";
import type { ActionErrorCode } from "@/lib/admin/actions";
import { requestRefundAction, transitionOrderAction } from "@/lib/admin/actions";
import { canRefund } from "@/lib/admin/order-status";
import type { CreateRefundRequest } from "@/lib/admin/schemas";

import { OrderStatusControl } from "./order-status-control";
import { RefundForm } from "./refund-form";

/**
 * DOM ids for the two inspector panels.
 *
 * Exported so the mismatch decision panel on the server-rendered page can point
 * its two resolutions at the controls that actually perform them, instead of
 * growing a second copy of each mutation with its own validation. There is
 * exactly one `OrderActions` per order page, so these are unique by
 * construction — unlike the dialog ids that `type-to-confirm-button` had to
 * move to `useId()`, which duplicate as soon as two dialogs coexist.
 */
export const ORDER_STATUS_PANEL_ID = "order-status-panel";
export const ORDER_REFUND_PANEL_ID = "order-refund-panel";

/**
 * What a mutation reports back to the control that triggered it.
 *
 * THE CODE TRAVELS, THE MESSAGE DOES NOT. `lib/admin/actions.ts` is explicit
 * that `result.message` is "the API's own English written for a log" and that
 * the failure branch carries `code` precisely so a client "branches on a CLOSED
 * enum against the message catalog"; `message` survives only because existing
 * callers still read it, and "new surfaces render code". Rethrowing
 * `new Error(result.message)` — what this file used to do — put a server-authored
 * English sentence in front of a Spanish operator, which is the rule the repo
 * states in as many words. `type-to-confirm-button.tsx` already calls that read
 * "a one-component slip"; this file is no longer the second one.
 *
 * `code` is nullable because a throw that never reached the API (a zod refusal
 * in the action itself, a network object with no envelope) has no code to
 * carry. Consumers map `null` onto the generic sentence.
 */
export type OrderMutationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ActionErrorCode | null };

export interface OrderActionsProps {
  readonly orderNumber: string;
  readonly status: OrderStatus;
  readonly currency: CurrencyCode;
  readonly locale: Locale;
  /** `grandTotal − refundedTotal`, computed by the page with @akai/money. */
  readonly remainingRefundable: Minor;
  /** Already refunded, for the refund panel's ledger. */
  readonly refundedTotal: Minor;
}

/**
 * The client boundary for the two mutating controls on an order.
 *
 * `router.refresh()` after a successful mutation re-runs the SERVER component
 * above, so the order detail, its timeline and its totals all come back from the
 * API rather than being patched locally. Optimistically updating a status here
 * would let the screen disagree with the state machine the moment the API
 * applied a rule the client does not model — and the state machine deliberately
 * has rules the client does not model.
 *
 * The router comes from `@/i18n/navigation`, not `next/navigation` — the
 * repo-wide `no-restricted-imports` rule grants that module the only exemption,
 * because a bare `next/navigation` router produces hrefs that drop the locale
 * prefix and silently kick English users back to Spanish on the next click.
 */
export function OrderActions({
  orderNumber,
  status,
  currency,
  locale,
  remainingRefundable,
  refundedTotal,
}: OrderActionsProps) {
  const router = useRouter();

  async function handleTransition(
    next: OrderStatus,
    note: string | undefined,
  ): Promise<OrderMutationOutcome> {
    const result = await transitionOrderAction(orderNumber, next, note);
    if (!result.ok) {
      return { ok: false, code: result.code };
    }
    router.refresh();
    return { ok: true };
  }

  async function handleRefund(
    body: CreateRefundRequest,
    idempotencyKey: string,
  ): Promise<OrderMutationOutcome> {
    const result = await requestRefundAction(orderNumber, body, idempotencyKey);
    if (!result.ok) {
      return { ok: false, code: result.code };
    }
    router.refresh();
    return { ok: true };
  }

  return (
    <div className="grid gap-4">
      <div id={ORDER_STATUS_PANEL_ID}>
        <OrderStatusControl
          orderNumber={orderNumber}
          current={status}
          onTransition={handleTransition}
        />
      </div>

      {/*
        `canRefund` gates whether the panel EXISTS, not whether it is enabled:
        it is meaningless on an order whose money never settled, and a disabled
        refund form invites an operator to hunt for the permission that would
        turn it on.
      */}
      {canRefund(status, remainingRefundable) && (
        <div id={ORDER_REFUND_PANEL_ID}>
          <RefundForm
            currency={currency}
            locale={locale}
            remainingRefundable={remainingRefundable}
            refundedTotal={refundedTotal}
            onSubmit={handleRefund}
          />
        </div>
      )}
    </div>
  );
}
