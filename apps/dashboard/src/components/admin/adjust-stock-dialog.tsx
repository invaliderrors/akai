"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import {
  inventoryAdjustFailureReasonSchema,
  type InventoryAdjustFailureReason,
} from "@akai/contracts";

import { Button, IconButton } from "@/components/ui/button";
import { PopupButton, TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Dialog } from "@/components/ui/overlay";
import { useRouter } from "@/i18n/navigation";
import { adjustInventoryAction } from "@/lib/admin/actions";

/**
 * Change one variant's stock, through the ledger.
 *
 * A DIALOG OFF A ROW ACTION, NOT AN EDITABLE CELL. The variant table is
 * read-only on purpose — each variant carries an optimistic-concurrency
 * `version`, so inline editing would need per-row conflict handling and a stale
 * write would silently lose an operator's change. A deliberate dialog is the
 * honest write surface, and it is the first caller `adjustInventoryAction` has
 * ever had.
 *
 * THE OPERATOR TYPES AN ABSOLUTE COUNT; THE API TAKES A SIGNED DELTA. Counting a
 * shelf produces "there are 37", not "add 8", so the delta is computed here and
 * SHOWN before it is sent — an operator confirms the movement they are about to
 * record, not just the number they typed.
 *
 * THE REASON IS NEVER AUTO-GENERATED. It is written to an append-only ledger a
 * human reads back later, so a machine-written "Dashboard stock edit" would be
 * exactly the unexplainable row the field exists to prevent. It is also sent as
 * a STABLE TOKEN plus an optional note rather than as UI copy: an auditor should
 * not have to know which language the operator's browser was in.
 *
 * THE COUNT IT DISPLAYED GOES WITH THE DELTA, AS `expectedOnHand`. The delta is
 * only right if the shelf count it was computed from is still the stored one;
 * an order that reserved or sold in between would otherwise make the ledger
 * land on a number the operator never typed. The API refuses that as
 * STOCK_CHANGED, and this dialog says "reload" rather than "it failed".
 *
 * REFUSALS ARE NAMED FROM THE ENVELOPE'S `reason`, parsed against the closed
 * contracts enum and mapped through a TOTAL record — a new reason is a compile
 * error here, not a blank notice. The server's English `message` is never
 * shown; anything unrecognised falls back to the generic sentence.
 */

const REFUSAL_KEYS = {
  STOCK_CHANGED: "stock.errors.STOCK_CHANGED",
  BELOW_RESERVED: "stock.errors.BELOW_RESERVED",
  NEGATIVE_STOCK: "stock.errors.NEGATIVE_STOCK",
} as const satisfies Readonly<Record<InventoryAdjustFailureReason, string>>;

const REASONS = ["STOCK_COUNT", "RESTOCK", "DAMAGE", "CORRECTION", "OTHER"] as const;
type StockReason = (typeof REASONS)[number];

export interface AdjustStockDialogProps {
  readonly variantId: string;
  readonly sku: string;
  readonly onHand: number;
  readonly reserved: number;
}

export function AdjustStockDialog({
  variantId,
  sku,
  onHand,
  reserved,
}: AdjustStockDialogProps) {
  const t = useTranslations("admin.productForm");
  const tUi = useTranslations("ui");
  const router = useRouter();
  const titleId = useId();

  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(String(onHand));
  const [reason, setReason] = useState<StockReason>("STOCK_COUNT");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = Number(target.trim());
  const valid = target.trim() !== "" && Number.isSafeInteger(parsed) && parsed >= 0;
  const delta = valid ? parsed - onHand : 0;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const trimmed = note.trim();
      const result = await adjustInventoryAction(variantId, {
        delta,
        reason: trimmed === "" ? reason : `${reason}: ${trimmed}`,
        expectedOnHand: onHand,
      });
      if (!result.ok) {
        const refusal = inventoryAdjustFailureReasonSchema.safeParse(result.reason);
        setError(refusal.success ? t(REFUSAL_KEYS[refusal.data]) : t("stock.failed"));
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <IconButton
        label={t("stock.adjust")}
        icon="sliders-horizontal"
        variant="plain"
        size="mini"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      />
      <Dialog open={open} onClose={() => setOpen(false)} labelledBy={titleId}>
        <div className="grid gap-3 p-[var(--card-p)]">
          <h2
            id={titleId}
            className="text-[15px] leading-5 font-semibold tracking-[-0.23px] text-[var(--label)]"
          >
            {t("stock.title", { sku })}
          </h2>

          <dl className="grid grid-cols-2 gap-2 text-[12px]">
            <div>
              <dt className="text-[var(--label-secondary)]">{t("stock.onHandLabel")}</dt>
              <dd className="tabular-nums text-[var(--label)]">{onHand}</dd>
            </div>
            <div>
              <dt className="text-[var(--label-secondary)]">
                {t("stock.reservedLabel")}
              </dt>
              <dd className="tabular-nums text-[var(--label)]">{reserved}</dd>
            </div>
          </dl>

          <TextField
            label={t("stock.targetLabel")}
            name={`stock-target-${variantId}`}
            value={target}
            inputMode="numeric"
            onChange={setTarget}
          />

          <p className="text-[12px] text-[var(--label-secondary)]">
            {t("stock.deltaLabel")}:{" "}
            <span className="tabular-nums text-[var(--label)]">
              {delta > 0 ? `+${delta}` : String(delta)}
            </span>
          </p>

          <PopupButton<StockReason>
            label={t("stock.reasonLabel")}
            name={`stock-reason-${variantId}`}
            value={reason}
            hint={t("stock.reasonHint")}
            options={REASONS.map((value) => ({
              value,
              label: t(`stock.reasons.${value}`),
            }))}
            onChange={setReason}
          />

          <TextField
            label={t("stock.noteLabel")}
            name={`stock-note-${variantId}`}
            value={note}
            onChange={setNote}
          />

          {error !== null && <Notice tone="danger">{error}</Notice>}
          {delta === 0 && (
            <p className="text-[12px] text-[var(--label-tertiary)]">
              {t("stock.unchanged")}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="standard"
              size="compact"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              {tUi("cancel")}
            </Button>
            <Button
              variant="prominent"
              size="compact"
              onClick={() => void submit()}
              pending={busy}
              pendingLabel={tUi("saving")}
              // The schema rejects a zero delta, and an operator who changed
              // nothing must meet a disabled button rather than a validation
              // error explaining what they did not do.
              disabled={busy || !valid || delta === 0}
            >
              {t("stock.confirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
