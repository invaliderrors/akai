"use client";

import { useId, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { Batch } from "@akai/contracts";

import { Button, IconButton } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Dialog } from "@/components/ui/overlay";
import { Notice } from "@/components/ui/notice";
import { useRouter } from "@/i18n/navigation";
import type { ActionResult } from "@/lib/admin/actions";
import {
  ACCEPTED_COA_TYPE,
  MAX_COA_BYTES,
  uploadBatchCoa,
  type CoaUploadDeps,
} from "@/lib/admin/upload-batch-coa";

/**
 * The lot (batch) and certificate-of-analysis control for ONE variant.
 *
 * ADMIN RECORD ONLY. A lot and its certificate are the operator's record; the
 * storefront no longer reads them. The shop's purity claim is fixed sitewide
 * and the certificate it offers is the PRODUCT's (`ProductCoaField`, with its
 * own "show" switch) — so nothing uploaded here reaches a shopper.
 *
 * It calls the three admin routes that create a lot, mint an upload URL, and
 * attach the result.
 *
 * TWO STEPS IN ONE DIALOG, NOT TWO CONTROLS. A variant has no batch until an
 * operator records one (lot code, purity, test method, tested date) — there is
 * nothing to upload a certificate ONTO before that exists. Once it does, the
 * same dialog session moves straight to the file picker rather than closing
 * and asking the operator to reopen a second control.
 *
 * NO STAGED MODE, unlike `VariantImageField`. A batch is keyed by `variantId`,
 * and a variant has no id until the product is saved — so this control simply
 * does not render for a variant that has not been saved yet. `product-form.tsx`
 * enforces that by only ever constructing this component for a STORED variant.
 */
export interface BatchCoaUploads {
  readonly onCreateBatch: (
    variantId: string,
    input: {
      lotCode: string;
      purityPercent: number;
      testedAt: string;
      testMethod: string;
    },
  ) => Promise<ActionResult<Batch>>;
  readonly onRequestUpload: CoaUploadDeps["requestUpload"];
  readonly onAttach: CoaUploadDeps["attach"];
}

interface BatchCoaFieldProps {
  readonly variantName: string;
  readonly variantId: string;
  /** What the server currently holds for this variant, or none yet. */
  readonly batch: Batch | null;
  readonly uploads: BatchCoaUploads;
  readonly disabled?: boolean;
}

export function BatchCoaField({
  variantName,
  variantId,
  batch,
  uploads,
  disabled = false,
}: BatchCoaFieldProps) {
  const t = useTranslations("admin.batchCoa");
  const tUi = useTranslations("ui");
  const router = useRouter();
  const headingId = useId();
  const [open, setOpen] = useState(false);

  // A batch created DURING this dialog session, so the flow can move straight
  // to the upload step without waiting for the page's own data to refresh.
  // `batch` (the prop) still wins once it catches up, after `router.refresh()`.
  const [sessionBatch, setSessionBatch] = useState<Batch | null>(null);
  const effectiveBatch = batch ?? sessionBatch;

  const [lotCode, setLotCode] = useState("");
  const [purityPercent, setPurityPercent] = useState("");
  const [testMethod, setTestMethod] = useState("");
  const [testedAt, setTestedAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(false);

  function reset() {
    setLotCode("");
    setPurityPercent("");
    setTestMethod("");
    setTestedAt("");
    setCreateError(null);
    setUploadError(null);
    setUploaded(false);
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function handleCreateBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const purity = Number(purityPercent);
    const validPurity = Number.isFinite(purity) && purity >= 0 && purity <= 100;

    if (lotCode.trim() === "" || testMethod.trim() === "" || testedAt.trim() === "" || !validPurity) {
      setCreateError(t("invalidBatch"));
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const result = await uploads.onCreateBatch(variantId, {
        lotCode: lotCode.trim(),
        purityPercent: purity,
        testMethod: testMethod.trim(),
        testedAt: new Date(testedAt).toISOString(),
      });

      if (!result.ok) {
        setCreateError(result.code === "CONFLICT" ? t("duplicateLot") : t("createFailed"));
        return;
      }

      setSessionBatch(result.data);
      router.refresh();
    } finally {
      setCreating(false);
    }
  }

  async function handleFile(file: File | undefined) {
    if (file === undefined || effectiveBatch === null) return;

    setUploading(true);
    setUploadError(null);
    setUploaded(false);
    try {
      const outcome = await uploadBatchCoa(
        { requestUpload: uploads.onRequestUpload, attach: uploads.onAttach },
        { batchId: effectiveBatch.id, file },
      );

      if (!outcome.ok) {
        setUploadError(t(`uploadError.${outcome.reason}`));
        return;
      }

      setUploaded(true);
      router.refresh();
    } finally {
      setUploading(false);
    }
  }

  const hasCoa = effectiveBatch !== null && effectiveBatch.coaUrl !== null;

  return (
    <>
      <IconButton
        label={hasCoa ? t("view", { variant: variantName }) : t("add", { variant: variantName })}
        icon="file-text"
        variant={hasCoa ? "prominent" : "standard"}
        size="mini"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      />

      <Dialog open={open} onClose={close} labelledBy={headingId} surface="opaque">
        <div className="grid gap-3 p-4">
          <div className="grid gap-0.5">
            <h2 id={headingId} className="m-0 text-[15px] font-semibold text-[var(--label)]">
              {t("title", { variant: variantName })}
            </h2>
            <p className="m-0 text-[11px] leading-4 text-[var(--label-secondary)]">
              {t("hint")}
            </p>
          </div>

          {effectiveBatch === null ? (
            <form className="grid gap-3" onSubmit={(event) => void handleCreateBatch(event)}>
              <TextField
                label={t("lotCodeLabel")}
                name="lotCode"
                value={lotCode}
                onChange={setLotCode}
                disabled={creating}
                autoFocus
              />
              <TextField
                label={t("purityLabel")}
                name="purityPercent"
                value={purityPercent}
                onChange={setPurityPercent}
                inputMode="decimal"
                disabled={creating}
              />
              <TextField
                label={t("testMethodLabel")}
                name="testMethod"
                value={testMethod}
                onChange={setTestMethod}
                disabled={creating}
              />
              <TextField
                label={t("testedAtLabel")}
                name="testedAt"
                type="date"
                value={testedAt}
                onChange={setTestedAt}
                disabled={creating}
              />
              {createError !== null && (
                <Notice tone="danger">{createError}</Notice>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="standard" size="compact" type="button" onClick={close}>
                  {tUi("cancel")}
                </Button>
                <Button variant="prominent" size="compact" type="submit" disabled={creating}>
                  {creating ? t("recording") : t("recordBatch")}
                </Button>
              </div>
            </form>
          ) : (
            <div className="grid gap-3">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                <dt className="text-[var(--label-secondary)]">{t("lotCodeLabel")}</dt>
                <dd className="m-0 text-[var(--label)]">{effectiveBatch.lotCode}</dd>
                <dt className="text-[var(--label-secondary)]">{t("purityLabel")}</dt>
                <dd className="m-0 text-[var(--label)]">{effectiveBatch.purityPercent}%</dd>
                <dt className="text-[var(--label-secondary)]">{t("testMethodLabel")}</dt>
                <dd className="m-0 text-[var(--label)]">{effectiveBatch.testMethod}</dd>
              </dl>

              {hasCoa && effectiveBatch.coaUrl !== null && (
                <a
                  href={effectiveBatch.coaUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13px] font-medium text-[var(--accent)] underline"
                >
                  {t("viewCurrent")}
                </a>
              )}

              <label className="grid gap-1 text-[13px] font-medium text-[var(--label-secondary)]">
                {hasCoa ? t("replaceLabel") : t("uploadLabel")}
                <input
                  type="file"
                  accept={ACCEPTED_COA_TYPE}
                  disabled={uploading}
                  onChange={(event) => void handleFile(event.target.files?.[0])}
                  className="text-[13px]"
                />
              </label>
              <p className="m-0 text-[11px] text-[var(--label-secondary)]">
                {t("sizeHint", { maxMb: Math.floor(MAX_COA_BYTES / (1024 * 1024)) })}
              </p>

              {uploading && <Notice tone="progress">{t("uploading")}</Notice>}
              {uploaded && <Notice tone="success">{t("uploadSuccess")}</Notice>}
              {uploadError !== null && <Notice tone="danger">{uploadError}</Notice>}

              <div className="justify-self-end">
                <Button variant="standard" size="compact" onClick={close}>
                  {tUi("close")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}
