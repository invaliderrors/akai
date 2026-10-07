"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import type { CurrencyCode, Locale, Minor, RefundReason } from "@akai/contracts";
import { formatMoney } from "@akai/money";

import { Button } from "@/components/ui/button";
import { ConfirmActionError, TypeToConfirmDialog } from "@/components/ui/confirm";
import {
  MoneyField,
  PopupButton,
  TextArea,
  TextField,
  type MoneyFieldValue,
} from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Money } from "@/components/ui/money";
import {
  formatMinorAsInput,
  parseMajorUnitInput,
  type MoneyInputError,
} from "@/lib/admin/money-input";
import type { CreateRefundRequest } from "@/lib/admin/schemas";

import type { OrderMutationOutcome } from "./order-actions";
import { reasonKey } from "./order-status-control";

export interface RefundFormProps {
  readonly currency: CurrencyCode;
  readonly locale: Locale;
  /** `grandTotal − refundedTotal`, computed by the page. Display bound only. */
  readonly remainingRefundable: Minor;
  /** What has already gone back, for the panel's ledger. */
  readonly refundedTotal: Minor;
  /**
   * Receives the request body AND the idempotency key to send with it. The key
   * is owned by this component rather than by the caller so its lifecycle —
   * reused across retries of one attempt, rotated after a success — is bound to
   * the form the operator is actually looking at. See `idempotencyKey` below.
   */
  readonly onSubmit: (
    body: CreateRefundRequest,
    idempotencyKey: string,
  ) => Promise<OrderMutationOutcome>;
  /**
   * Seam for tests. Production leaves it unset and gets `crypto.randomUUID`;
   * injecting a counter keeps the idempotency assertions deterministic without
   * stubbing a global.
   */
  readonly generateKey?: () => string;
}

/**
 * The six members of `refundReasonSchema`, in the order an operator meets them.
 *
 * WITHDRAWAL_RIGHT IS SECOND, AND IT IS AN ADDITION TO THE ARTBOARD. It is the
 * consumer's right to withdraw (in Colombia the "derecho de retracto", Ley 1480
 * art. 47), a common reason a clothing shop refunds, and the drawing omits it.
 *
 * The drawn first option, "Cobro incorrecto del proveedor", HAS NO ENUM MEMBER
 * behind it. `createRefundSchema` is `.strict()` and types `reason` against
 * `refundReasonSchema`, so shipping that label would either 400 at the boundary
 * or require inventing a member the Prisma enum does not mirror. It maps to
 * OTHER plus the free-text note (max 1000, already on the schema), which is
 * exactly what the note is for.
 */
const REASONS: readonly RefundReason[] = [
  "REQUESTED_BY_CUSTOMER",
  "WITHDRAWAL_RIGHT",
  "DAMAGED",
  "DUPLICATE",
  "FRAUDULENT",
  "OTHER",
];

/** The API's own ceiling on `note`. Mirrored so the counter cannot disagree. */
const NOTE_MAX = 1000;

/** The API's ceiling on the Wompi refund reference. */
const PROVIDER_REF_MAX = 128;

/**
 * Record a refund the operator ALREADY made in the Wompi dashboard.
 *
 * THREE THINGS THIS FORM DOES NOT DO, each deliberate:
 *
 *  - It does not move money. Wompi has no refund API for Web Checkout
 *    payments, so the money goes back in the Wompi dashboard, by hand; this
 *    records it (SUCCEEDED), moves the order to PARTIALLY_REFUNDED / REFUNDED
 *    and emails the customer. The copy says so, because an operator who
 *    believes this form refunds will tell the customer money is on its way when
 *    nothing was sent.
 *  - It does not decide the amount. Leaving the field empty means "the full
 *    remaining balance", resolved SERVER-SIDE — the common case and the one most
 *    likely to be mistyped. Any amount entered is still bounded server-side by
 *    `grandTotal - refundedTotal`; the client-side cap below only stops an
 *    obvious mistake before the round trip.
 *  - It does not mint a fresh idempotency key per click. See below — that detail
 *    is the difference between one refund and three.
 *
 * WHY THIS PANEL IS NOT A `<Card>`: the drawn surface carries the card's
 * hairline AND a `--danger-ring` outline, and both are `box-shadow`. Two
 * `shadow-[…]` utilities on one element do not compose — they resolve by the
 * order Tailwind emits them, which no call site controls — so the two layers
 * are written as one shadow here rather than as a `className` fighting Card's.
 */
export function RefundForm({
  currency,
  locale,
  remainingRefundable,
  refundedTotal,
  onSubmit,
  generateKey,
}: RefundFormProps) {
  const t = useTranslations("admin.orderDetail");
  const tUi = useTranslations("ui");
  const tRoot = useTranslations();
  const tMoney = useTranslations("admin.common.moneyErrors");

  const mintKey = generateKey ?? (() => crypto.randomUUID());

  const [amount, setAmount] = useState<MoneyFieldValue>({ raw: "", minor: null });
  const [reason, setReason] = useState<RefundReason>("REQUESTED_BY_CUSTOMER");
  const [note, setNote] = useState("");
  const [providerRefundId, setProviderRefundId] = useState("");
  const [amountError, setAmountError] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  /**
   * The idempotency key for the CURRENT refund attempt (spec §9).
   *
   * Minted once, then held across failures and REUSED on every retry: if the
   * first request actually reached the API and the response was lost to a
   * timeout, the retry replays the stored response instead of issuing a second
   * refund. Generating a new key per click would make each retry a fresh
   * money-creating request — worse than having no key at all, because it looks
   * protected.
   *
   * It rotates only after a SUCCESS, because at that point the next submission
   * is a genuinely different refund (a second partial against the same order).
   * Holding the key across a success would make that second refund silently
   * replay the first one's response and move no money at all.
   */
  const [idempotencyKey, setIdempotencyKey] = useState<string>(mintKey);

  // `useId`, not a literal: this panel is `aria-labelledby` its own heading, and
  // a hardcoded id is a duplicate the moment anything renders two of them —
  // the bug that pushed `type-to-confirm-button` onto generated ids.
  const headingId = useId();

  /**
   * Translated parse failures, as a TOTAL `Record` over the closed union.
   *
   * `MONEY_INPUT_MESSAGES` in `lib/admin/money-input.ts` is still hardcoded
   * English and its own comment calls that the remaining debt; reading the
   * catalogue here is the swap, and totality means a new parser failure mode is
   * a compile error rather than a blank message beside a refund.
   */
  const moneyErrors: Readonly<Record<MoneyInputError, string>> = {
    EMPTY: tMoney("EMPTY"),
    NOT_A_NUMBER: tMoney("NOT_A_NUMBER"),
    GROUPING_SEPARATOR: tMoney("GROUPING_SEPARATOR"),
    NEGATIVE: tMoney("NEGATIVE"),
    TOO_MANY_DECIMALS: tMoney("TOO_MANY_DECIMALS"),
    TOO_LARGE: tMoney("TOO_LARGE"),
  };

  const reasonLabel = (value: RefundReason): string => t(`refundReasons.${value}`);

  /**
   * What this submission will actually refund.
   *
   * `null` while the typed amount is not a complete, valid figure — which is
   * also what stops the confirmation opening, because the phrase the operator
   * must type IS that figure. A blank field resolves to the whole remaining
   * balance, which is the value the SERVER will pick; showing anything else in
   * the dialog would be a different number from the one that moves.
   */
  const effective: Minor | null = amount.raw.trim() === "" ? remainingRefundable : amount.minor;

  /** Validates the typed amount, returning the message to show or `undefined`. */
  function validateAmount(): string | undefined {
    const trimmed = amount.raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const parsed = parseMajorUnitInput(trimmed, currency);
    if (!parsed.ok) {
      return moneyErrors[parsed.error];
    }
    if (parsed.value === 0) {
      return t("refundAboveZero");
    }
    if (parsed.value > remainingRefundable) {
      return t("refundTooLarge", {
        amount: formatMoney(remainingRefundable, currency, locale),
      });
    }
    return undefined;
  }

  function handleOpenConfirm(): void {
    const problem = validateAmount();
    setAmountError(problem);
    if (problem === undefined) {
      setConfirming(true);
    }
  }

  async function handleConfirm(): Promise<void> {
    if (effective === null) {
      return;
    }

    const trimmedNote = note.trim();
    const trimmedReference = providerRefundId.trim();
    const outcome = await onSubmit(
      {
        // The key is OMITTED entirely rather than set to `undefined`: the API's
        // schema is `.strict()`, and "absent" is what means "refund the full
        // remaining balance". `exactOptionalPropertyTypes` would reject the
        // explicit spelling anyway.
        ...(amount.raw.trim() === "" || amount.minor === null
          ? {}
          : { amount: amount.minor }),
        reason,
        ...(trimmedNote.length === 0 ? {} : { note: trimmedNote }),
        ...(trimmedReference.length === 0 ? {} : { providerRefundId: trimmedReference }),
        restockVariantIds: [],
      },
      idempotencyKey,
    );

    if (!outcome.ok) {
      // Deliberately does NOT rotate the key. A retry of this same attempt must
      // carry the same key so a lost-response timeout replays rather than
      // double-refunds — and the dialog stays open, because a destructive
      // dialog that closes on failure looks exactly like one that succeeded.
      throw new ConfirmActionError(tRoot(reasonKey(outcome.code)));
    }

    setAmount({ raw: "", minor: null });
    setNote("");
    setProviderRefundId("");
    // Success: the next submission is a DIFFERENT refund, so it needs its own
    // key. Reusing this one would replay this response and move no money.
    setIdempotencyKey(mintKey());
  }

  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-2.5 rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-[var(--card-p)] shadow-[var(--e-0),0_0_0_1px_var(--danger-ring)]"
    >
      <div className="flex items-center gap-2">
        <Icon name="banknote" size={16} className="text-[var(--danger)]" />
        <h2
          id={headingId}
          className="m-0 text-[15px] leading-5 font-semibold tracking-[-0.23px] text-[var(--label)]"
        >
          {t("refundHeading")}
        </h2>
      </div>

      <p className="m-0 text-[12px] leading-[1.4] text-[var(--label-secondary)]">
        {t("refundIntent")}
      </p>

      <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-[2px] text-[12px]">
        <dt className="text-[var(--label-secondary)]">{t("refundAlready")}</dt>
        <dd className="m-0 text-right">
          <Money amount={refundedTotal} currency={currency} locale={locale} />
        </dd>
      </dl>

      <MoneyField
        label={t("refundAmountLabel", { currency })}
        name="amount"
        value={amount.raw}
        currency={currency}
        onChange={(next) => {
          setAmount(next);
          setAmountError(undefined);
        }}
        hint={t("refundAmountHint", {
          max: formatMoney(remainingRefundable, currency, locale),
        })}
        errorMessages={moneyErrors}
        placeholder={formatMinorAsInput(remainingRefundable, currency)}
        {...(amountError === undefined ? {} : { error: amountError })}
      />

      <PopupButton<RefundReason>
        label={t("refundReasonLabel")}
        name="reason"
        value={reason}
        options={REASONS.map((value) => ({ value, label: reasonLabel(value) }))}
        onChange={setReason}
      />

      <TextField
        label={t("refundProviderLabel")}
        name="providerRefundId"
        value={providerRefundId}
        maxLength={PROVIDER_REF_MAX}
        hint={t("refundProviderHint")}
        mono
        onChange={setProviderRefundId}
      />

      <TextArea
        label={t("refundNoteLabel")}
        name="note"
        value={note}
        rows={2}
        maxLength={NOTE_MAX}
        onChange={setNote}
      />

      <Button
        variant="destructive"
        onClick={handleOpenConfirm}
        disabled={remainingRefundable <= 0}
      >
        {t("refundSubmit")}
      </Button>

      <p className="m-0 text-[11px] leading-[1.35] text-[var(--label-secondary)]">
        {t("refundConfirmHint")}
      </p>

      {effective === null ? null : (
        <TypeToConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={t("refundConfirmTitle", {
            amount: formatMoney(effective, currency, locale),
          })}
          consequence={t("refundConfirmBody")}
          icon="banknote"
          // The figure as the field spells it, not as the locale formats it:
          // the operator has to be able to TYPE it back, and "4,95 €" is not
          // what the amount input accepts. `amount` kind, not `identifier` —
          // money never takes the mono face.
          phrase={formatMinorAsInput(effective, currency)}
          phraseKind="amount"
          prompt={(chip) => tUi.rich("typePrompt", { phrase: () => chip })}
          mismatchHint={tUi("mismatch")}
          ledger={[
            {
              label: t("refundAmountLabel", { currency }),
              value: <Money amount={effective} currency={currency} locale={locale} emphasis />,
              emphasis: true,
            },
            { label: t("refundReasonLabel"), value: reasonLabel(reason) },
          ]}
          confirmLabel={t("refundConfirmAction")}
          cancelLabel={tUi("cancel")}
          busyLabel={t("refundBusy")}
          fallbackError={t("refundFallback")}
          density="compact"
          onConfirm={handleConfirm}
        />
      )}
    </section>
  );
}
