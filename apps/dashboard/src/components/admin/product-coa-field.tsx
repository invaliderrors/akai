"use client";

import { useId, useRef, useState, type DragEvent } from "react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { ConfirmActionError, ConfirmAlert } from "@/components/ui/confirm";
import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/ui/notice";
import { Checkbox } from "@/components/ui/toggle";
import { useRouter } from "@/i18n/navigation";
import type { ActionResult } from "@/lib/admin/actions";
import {
  ACCEPTED_COA_TYPE,
  MAX_COA_BYTES,
  uploadCoaPdf,
  type CoaUploadFailure,
} from "@/lib/admin/upload-batch-coa";

/**
 * The PRODUCT's certificate of analysis, as ONE section in two steps:
 *
 *   1. THE FILE — a drop zone while none is uploaded; once there is one, a file
 *      row with View / Replace / Remove. Written IMMEDIATELY (presign → PUT →
 *      confirm against `POST /v1/admin/products/:id/coa/...`).
 *   2. VISIBILITY — "Show on the product page", a FORM value saved with the rest
 *      of the product. Some certificates are uploaded before they are ready to
 *      publish, so an upload alone must never put one in front of a shopper;
 *      and a Save-button form must not hide a control that commits on flip,
 *      which is why this is a checkbox with an explicit "applies when you save"
 *      line rather than the auto-saving `Switch`.
 *
 * The header badge states the one fact the operator actually wants to know —
 * is the certificate visible in the shop right now (as saved) — so nobody has
 * to reason about "file AND switch" to find out.
 *
 * EXISTING PRODUCTS ONLY for the upload: the object key is derived from the
 * product id, which a product being created does not have yet. `uploads` is
 * undefined for a new product and the section says why.
 *
 * "View" follows `coaUrl`, a signed URL the API mints fresh on every admin read
 * of the product — and `router.refresh()` after each change re-reads it — so
 * the link always points at the current file.
 */
export interface ProductCoaUploads {
  readonly productId: string;
  readonly onRequestUpload: (
    productId: string,
    input: { sizeBytes: number },
  ) => Promise<ActionResult<{ uploadUrl: string; objectKey: string }>>;
  readonly onAttach: (
    productId: string,
    input: { objectKey: string },
  ) => Promise<ActionResult<unknown>>;
  readonly onRemove: (productId: string) => Promise<ActionResult<unknown>>;
}

interface ProductCoaFieldProps {
  /** Undefined for a product that has not been saved yet. */
  readonly uploads: ProductCoaUploads | undefined;
  /** A freshly signed URL for the current file, or null when none is uploaded. */
  readonly coaUrl: string | null;
  /** The form's current (unsaved) visibility choice. */
  readonly showCoa: boolean;
  /** Visibility as last SAVED — what the shop does right now. */
  readonly savedShowCoa: boolean;
  readonly onShowCoaChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}

type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "uploading" }
  | { readonly kind: "uploaded" }
  | { readonly kind: "uploadFailed"; readonly reason: CoaUploadFailure }
  | { readonly kind: "removed" };

export function ProductCoaField({
  uploads,
  coaUrl,
  showCoa,
  savedShowCoa,
  onShowCoaChange,
  disabled = false,
}: ProductCoaFieldProps) {
  const t = useTranslations("admin.productCoa");
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const busy = status.kind === "uploading";
  const hasFile = coaUrl !== null;
  const locked = disabled || busy || uploads === undefined;
  const maxMb = Math.floor(MAX_COA_BYTES / (1024 * 1024));

  const liveInShop = hasFile && savedShowCoa;

  async function handleFile(file: File | undefined) {
    if (file === undefined || uploads === undefined) return;

    setStatus({ kind: "uploading" });
    const outcome = await uploadCoaPdf(
      {
        requestUpload: (sizeBytes) => uploads.onRequestUpload(uploads.productId, { sizeBytes }),
        attach: (objectKey) => uploads.onAttach(uploads.productId, { objectKey }),
      },
      file,
    );

    if (!outcome.ok) {
      setStatus({ kind: "uploadFailed", reason: outcome.reason });
      return;
    }
    setStatus({ kind: "uploaded" });
    router.refresh();
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (locked) return;
    void handleFile(event.dataTransfer.files[0]);
  }

  return (
    <div data-testid="product-coa-field" className="grid gap-4">
      <div className="flex items-center gap-2">
        <Badge
          tone={liveInShop ? "success" : "neutral"}
          label={liveInShop ? t("statusVisible") : hasFile ? t("statusHidden") : t("statusNoFile")}
          density="compact"
        />
      </div>

      {/* STEP 1 — the file */}
      <section aria-labelledby={`${inputId}-file`} className="grid gap-2">
        <h3 id={`${inputId}-file`} className="m-0 text-[13px] font-semibold text-[var(--label)]">
          {t("fileStep")}
        </h3>

        {/* One hidden input serves the drop zone AND "Replace". Cleared after
            each pick so choosing the SAME file again still fires `change`. */}
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={ACCEPTED_COA_TYPE}
          disabled={locked}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void handleFile(file);
          }}
        />

        {uploads === undefined ? (
          <p className="m-0 rounded-[var(--r-control)] bg-[var(--fill-tertiary)] px-3 py-3 text-[13px] text-[var(--label-secondary)]">
            {t("afterSave")}
          </p>
        ) : hasFile ? (
          <div className="flex flex-wrap items-center gap-3 rounded-[var(--r-control)] border border-[var(--separator)] px-3 py-2.5">
            <span className="grid size-9 place-items-center rounded-[var(--r-control)] bg-[var(--fill-tertiary)] text-[var(--accent)]">
              <Icon name="file-text" size={18} />
            </span>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="text-[13px] font-medium text-[var(--label)]">{t("fileName")}</span>
              <span className="text-[11px] text-[var(--label-secondary)]">{t("fileMeta")}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <a
                href={coaUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--accent)]"
              >
                <Icon name="eye" size={14} />
                {t("view")}
              </a>
              <Button
                variant="standard"
                size="compact"
                disabled={locked}
                pending={busy}
                pendingLabel={t("uploading")}
                onClick={() => inputRef.current?.click()}
              >
                {t("replace")}
              </Button>
              <IconButton
                label={t("removeAria")}
                icon="trash-2"
                variant="standard"
                disabled={locked}
                onClick={() => setConfirmingRemove(true)}
              />
            </span>
          </div>
        ) : (
          <label
            htmlFor={inputId}
            onDragOver={(event) => {
              event.preventDefault();
              if (!locked) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`grid cursor-pointer justify-items-center gap-1.5 rounded-[var(--r-control)] border border-dashed px-4 py-6 text-center transition-colors ${
              dragging
                ? "border-[var(--accent)] bg-[var(--fill-tertiary)]"
                : "border-[var(--separator)] hover:border-[var(--accent)]"
            }${locked ? " cursor-not-allowed opacity-60" : ""}`}
          >
            <Icon name="file-text" size={22} className="text-[var(--label-secondary)]" />
            <span className="text-[13px] font-medium text-[var(--label)]">
              {busy ? t("uploading") : t("dropTitle")}
            </span>
            <span className="text-[11px] text-[var(--label-secondary)]">
              {t("dropHint", { maxMb })}
            </span>
          </label>
        )}

        {status.kind === "uploaded" && <Notice tone="success">{t("uploadSuccess")}</Notice>}
        {status.kind === "uploadFailed" && (
          <Notice tone="danger">{t(`uploadError.${status.reason}`)}</Notice>
        )}
        {status.kind === "removed" && <Notice tone="success">{t("removed")}</Notice>}
      </section>

      {/* STEP 2 — visibility, saved with the product */}
      <section aria-labelledby={`${inputId}-visibility`} className="grid gap-1.5">
        <h3 id={`${inputId}-visibility`} className="m-0 text-[13px] font-semibold text-[var(--label)]">
          {t("visibilityStep")}
        </h3>
        <Checkbox
          label={t("showLabel")}
          name="show-coa"
          checked={showCoa}
          disabled={disabled}
          onChange={onShowCoaChange}
        />
        <p className="m-0 text-[11px] leading-4 text-[var(--label-secondary)]">
          {hasFile ? t("showHint") : t("showHintNoFile")}
        </p>
        {showCoa !== savedShowCoa && (
          <p className="m-0 text-[11px] leading-4 font-medium text-[var(--label)]">{t("unsaved")}</p>
        )}
      </section>

      {uploads !== undefined && (
        <ConfirmAlert
          open={confirmingRemove}
          onClose={() => setConfirmingRemove(false)}
          title={t("removeTitle")}
          item={t("fileName")}
          consequence={t("removeBody")}
          confirmLabel={t("removeConfirm")}
          cancelLabel={t("cancel")}
          busyLabel={t("removing")}
          fallbackError={t("removeFailed")}
          density="compact"
          onConfirm={async () => {
            const result = await uploads.onRemove(uploads.productId);
            if (!result.ok) throw new ConfirmActionError(t("removeFailed"));
            setStatus({ kind: "removed" });
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
