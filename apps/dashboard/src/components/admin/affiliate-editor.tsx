"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { useRouter } from "@/i18n/navigation";
import {
  createAffiliateAction,
  deleteAffiliateAction,
  updateAffiliateAction,
  type ActionErrorCode,
} from "@/lib/admin/actions";
import type { AdminAffiliate } from "@/lib/admin/schemas";

import { AffiliateForm } from "./affiliate-form";
import { ConfirmActionError, TypeToConfirmButton } from "./type-to-confirm-button";

export interface AffiliateEditorProps {
  /** Absent when creating. */
  readonly affiliate?: AdminAffiliate;
  /** Where the form's Cancel goes. Defaults to the list. */
  readonly cancelHref?: string;
}

/**
 * The client boundary around the affiliate form. Mirrors `discount-editor.tsx`
 * exactly — see its own doc comment for why this whole shape exists (pages
 * stay server components; the closed-enum `ErrorCode` → translated-copy
 * mapping is enforced through a TOTAL `Record`, so a new code fails to
 * compile here until somebody writes copy for it).
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

/** null means the throw was not an API failure, so there is no code to map. */
export function actionErrorKey(code: ActionErrorCode | null): string {
  return code === null ? "errors.UNKNOWN" : ACTION_ERROR_KEYS[code];
}

export function AffiliateEditor({
  affiliate,
  cancelHref = "/admin/affiliates",
}: AffiliateEditorProps) {
  const t = useTranslations("admin.affiliates");
  const router = useRouter();
  const [error, setError] = useState<string | undefined>(undefined);

  /**
   * IT IS RENDERED ONLY WHEN THERE IS SOMETHING TO ARCHIVE. Hidden rather than
   * disabled on an already-archived affiliate — same reasoning
   * `discount-editor.tsx`'s identical branch gives: the API's soft delete is
   * idempotent and 404s on a second call. The confirm phrase is the social
   * handle, the one short identifier this record carries that reads like the
   * "code" every other `TypeToConfirmButton` caller in this product confirms
   * against.
   */
  const archiveAction =
    affiliate === undefined || affiliate.deletedAt !== null ? undefined : (
      <TypeToConfirmButton
        phrase={affiliate.socialHandle}
        triggerLabel={t("delete.trigger")}
        title={t("delete.title")}
        body={t("delete.body")}
        prompt={t.rich("delete.prompt", {
          phrase: affiliate.socialHandle,
          mono: (chunks) => <span className="font-mono font-semibold">{chunks}</span>,
        })}
        confirmLabel={t("delete.confirm")}
        busyLabel={t("delete.busy")}
        cancelLabel={t("delete.cancel")}
        fallbackError={t("delete.fallback")}
        onConfirm={async () => {
          const archived = await deleteAffiliateAction(affiliate.id);
          if (!archived.ok) {
            throw new ConfirmActionError(t(actionErrorKey(archived.code)));
          }
          router.push("/admin/affiliates");
          router.refresh();
        }}
      />
    );

  return (
    <AffiliateForm
      {...(affiliate === undefined ? {} : { affiliate })}
      formError={error}
      cancelHref={cancelHref}
      {...(archiveAction === undefined ? {} : { dangerAction: archiveAction })}
      onSubmit={async (submitted) => {
        setError(undefined);

        if (submitted.mode === "create") {
          const created = await createAffiliateAction(submitted.value);
          if (!created.ok) {
            setError(t(actionErrorKey(created.code)));
            return;
          }
          router.push(`/admin/affiliates/${created.data.id}`);
          return;
        }

        if (affiliate === undefined) {
          return;
        }

        const updated = await updateAffiliateAction(affiliate.id, submitted.value);
        if (!updated.ok) {
          setError(t(actionErrorKey(updated.code)));
          return;
        }
        router.refresh();
      }}
    />
  );
}
