"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { OrderStatus } from "@akai/contracts";

import { Button } from "@/components/ui/button";
import { ConfirmActionError, ConfirmAlert } from "@/components/ui/confirm";
import { PopupButton, TextField, type PopupButtonOption } from "@/components/ui/field";
import { Card } from "@/components/ui/card";
import { messageKey } from "@/lib/status";
import type { ActionErrorCode } from "@/lib/admin/actions";
import { adminTransitionOptions } from "@/lib/admin/order-status";

import type { OrderMutationOutcome } from "./order-actions";

export interface OrderStatusControlProps {
  /** Named in the confirmation, so the operator reads WHICH order they are moving. */
  readonly orderNumber: string;
  readonly current: OrderStatus;
  readonly onTransition: (
    status: OrderStatus,
    note: string | undefined,
  ) => Promise<OrderMutationOutcome>;
}

/**
 * The statuses whose side effects reach the customer, and therefore cannot be
 * taken back by selecting something else afterwards.
 *
 * SHIPPED and DELIVERED both send mail and both write an irreversible line on
 * the timeline. FULFILLING is internal and CANCELLED is already unmistakable in
 * the dropdown, so neither earns a second dialog — a confirm on every option is
 * a confirm nobody reads.
 */
const CONFIRM_REQUIRED: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "SHIPPED",
  "DELIVERED",
]);

/**
 * Every failure code, mapped onto the shared `errors` catalogue.
 *
 * A TOTAL `Record` over the closed union, so an `ErrorCode` added to
 * @akai/contracts is a COMPILE error here until somebody decides what the
 * operator is told about it — rather than a blank paragraph next to an order
 * that did not move. ILLEGAL_STATE_TRANSITION and CONFLICT are the two this
 * control actually provokes: the first is the state machine refusing the move,
 * the second is a concurrent edit having moved the order since the page
 * rendered. Both already have copy.
 *
 * `UNPARSEABLE_RESPONSE` and a null code both fall back to the generic
 * sentence: neither names anything the operator can act on.
 *
 * EXPORTED because the refund panel next door needs the same lookup for the
 * same reason, and two copies of a total map are two things to keep in step by
 * hand. It lives here rather than in `order-actions.tsx` — the natural home
 * beside `OrderMutationOutcome` — because that module imports both controls, so
 * a runtime export travelling the other way would close a module cycle.
 */
const REASON_KEY: Readonly<Record<ActionErrorCode, string>> = {
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
  UNPARSEABLE_RESPONSE: "errors.generic",
};

export function reasonKey(code: ActionErrorCode | null): string {
  return code === null ? "errors.generic" : REASON_KEY[code];
}

/**
 * The operator's lifecycle control for one order.
 *
 * The option list comes from `adminTransitionOptions`, which intersects the
 * state machine's legal-transition table (imported from @akai/contracts, shared
 * with the API) against the set an operator may assign by hand. Both halves
 * matter: offering an illegal move guarantees a 409, and offering PAID would let
 * a staff session forge the answer to "did the money arrive".
 *
 * THE ARTBOARD'S CAPTION IS WRONG IN BOTH DIRECTIONS and is not reproduced. It
 * reads "Resuelve el importe primero — solo transiciones permitidas; con un
 * importe no coincidente, ninguna", and from PAYMENT_MISMATCH the intersection
 * is `["CANCELLED"]`, not empty. The panel is live there, and cancelling is one
 * of the two resolutions the code actually offers.
 *
 * When the intersection IS empty the control renders nothing rather than a
 * disabled dropdown. A greyed-out control invites an operator to go hunting for
 * the permission that would enable it; there is no such permission.
 *
 * THE CONTROL IS A REAL `<select>` (`PopupButton` under `appearance:none`), not
 * a listbox rebuilt in React. Two tests walk `getAllByRole("option")` to prove
 * PAID is never offered from any status; a custom widget would make that
 * assertion unwritable, which is the assertion that stops "the money arrived"
 * from being forgeable by anyone with a staff session.
 */
export function OrderStatusControl({
  orderNumber,
  current,
  onTransition,
}: OrderStatusControlProps) {
  const t = useTranslations("admin.orderDetail");
  const tUi = useTranslations("ui");
  // Root namespace for statuses and error codes: `messageKey` builds the full
  // path, so the namespace and the domain are joined in exactly one place.
  const tRoot = useTranslations();

  const options = adminTransitionOptions(current);
  const [selected, setSelected] = useState<OrderStatus | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<OrderStatus | null>(null);

  const statusLabel = (status: OrderStatus): string => tRoot(messageKey("order", status));

  if (options.length === 0) {
    return (
      <Card title={t("statusHeading")}>
        <p data-testid="no-transitions" className="m-0 text-[13px] text-[var(--label-secondary)]">
          {t("noTransitions", { status: statusLabel(current) })}
        </p>
      </Card>
    );
  }

  /**
   * The failure sentence, built entirely from things this client already knows.
   *
   * `from` and `to` come from the CLIENT-side machine — the status the page
   * rendered and the option the operator picked — never from the server's
   * string. The server's `message` does not even cross the boundary any more;
   * only `code` does, and it is looked up in the catalogue.
   */
  function failureMessage(to: OrderStatus, code: ActionErrorCode | null): string {
    return t("transitionFailed", {
      from: statusLabel(current),
      to: statusLabel(to),
      reason: tRoot(reasonKey(code)),
    });
  }

  async function apply(target: OrderStatus): Promise<OrderMutationOutcome> {
    setBusy(true);
    setError(null);
    try {
      const trimmed = note.trim();
      const outcome = await onTransition(target, trimmed.length === 0 ? undefined : trimmed);
      if (outcome.ok) {
        setSelected("");
        setNote("");
      }
      return outcome;
    } finally {
      setBusy(false);
    }
  }

  async function handleApply(): Promise<void> {
    // Narrowed against the options actually OFFERED rather than cast. A cast
    // would let a tampered DOM value (or a renamed option) reach the request
    // body as an arbitrary string; the server rejects it either way, but this
    // keeps the client's own types honest.
    const target = asStatus(selected, options);
    if (target === null) {
      return;
    }

    if (CONFIRM_REQUIRED.has(target)) {
      setConfirmTarget(target);
      return;
    }

    const outcome = await apply(target);
    if (!outcome.ok) {
      setError(failureMessage(target, outcome.code));
    }
  }

  return (
    <Card title={t("statusHeading")}>
      <div className="grid gap-2.5">
        <PopupButton<OrderStatus | "">
          label={t("statusLabel")}
          name="status"
          value={selected}
          disabled={busy}
          hint={t("statusHint")}
          options={[
            { value: "", label: t("statusPlaceholder") },
            ...options.map(
              (option): PopupButtonOption<OrderStatus | ""> => ({
                value: option,
                label: statusLabel(option),
              }),
            ),
          ]}
          onChange={setSelected}
        />

        <TextField
          label={t("noteLabel")}
          name="note"
          value={note}
          disabled={busy}
          placeholder={t("notePlaceholder")}
          onChange={setNote}
        />

        {error === null ? null : (
          <p
            role="alert"
            className="m-0 text-[11px] leading-[1.35] font-medium text-[var(--danger-text)]"
          >
            {error}
          </p>
        )}

        <Button
          variant="prominent"
          onClick={() => {
            void handleApply();
          }}
          // `pending` blocks the second press by preventing default; DISABLING
          // it would drop focus to <body> at the exact moment the form has
          // something to say. Only "nothing chosen yet" disables.
          disabled={selected === ""}
          pending={busy}
          pendingLabel={t("applyingStatus")}
        >
          {t("applyStatus")}
        </Button>
      </div>

      {/*
        Mounted only for a target that needs confirming, and held in its OWN
        state so a success — which clears `selected` — cannot unmount the dialog
        out from under the request that is still resolving.
      */}
      {confirmTarget === null ? null : (
        <ConfirmAlert
          open
          onClose={() => setConfirmTarget(null)}
          title={t("confirmTransitionTitle", {
            orderNumber,
            status: statusLabel(confirmTarget),
          })}
          item={orderNumber}
          consequence={t("confirmTransitionBody")}
          // Not the default `trash-2`: nothing is being deleted. This dialog
          // guards a dispatch notification the customer receives.
          icon="truck"
          confirmLabel={t("confirmTransitionAction")}
          cancelLabel={tUi("cancel")}
          busyLabel={t("applyingStatus")}
          fallbackError={tUi("actionFailed")}
          density="compact"
          onConfirm={async () => {
            const outcome = await apply(confirmTarget);
            if (!outcome.ok) {
              // `ConfirmActionError` is the dialog's ONE channel for a message
              // the caller has marked as already translated. Anything else it
              // catches becomes `fallbackError`, which is exactly the guard
              // that stops a server-authored English string being rendered.
              throw new ConfirmActionError(failureMessage(confirmTarget, outcome.code));
            }
          }}
        />
      )}
    </Card>
  );
}

/**
 * Narrow the control's value against the options actually offered.
 *
 * Returns `null` rather than `""` so the caller cannot accidentally forward the
 * placeholder as a status.
 */
function asStatus(
  value: OrderStatus | "",
  options: readonly OrderStatus[],
): OrderStatus | null {
  return options.find((option) => option === value) ?? null;
}
