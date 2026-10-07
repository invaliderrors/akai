"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { useRouter } from "next/navigation";
import {
  createDiscountAction,
  deleteDiscountAction,
  updateDiscountAction,
  type ActionErrorCode,
} from "@/lib/admin/actions";
import type { AdminAffiliate, AdminDiscount } from "@/lib/admin/schemas";

import { DiscountForm } from "./discount-form";
import { ConfirmActionError, TypeToConfirmButton } from "./type-to-confirm-button";

export interface DiscountEditorProps {
  /** Absent when creating. */
  readonly discount?: AdminDiscount;
  /**
   * Where the form's Cancel goes. Defaults to the list.
   *
   * A prop because the same editor is rendered in two places: the detail route,
   * where cancelling means "back to the list", and the list's own inline panel,
   * where it means "close this panel and keep my filters, page size and cursor
   * stack exactly as they are". Only the caller knows which URL that is.
   */
  readonly cancelHref?: string;
  /** Forwarded to `DiscountForm`'s picker as-is. See its own doc comment. */
  readonly affiliates?: readonly AdminAffiliate[];
}

/**
 * The client boundary around the discount form.
 *
 * Exists so the pages stay server components: it holds the submit/error state
 * and calls the server actions, while every read happens server-side.
 * `fetch high, render pure`.
 *
 * THIS IS WHERE THE CLOSED-ENUM RULE IS ENFORCED. The action's failure branch
 * carries `code` — an `ErrorCode`, `"UNPARSEABLE_RESPONSE"`, or null — and this
 * component maps it onto `admin.discounts.errors.*` through a TOTAL `Record`.
 * That is the whole point of widening `ActionResult`: without the code the only
 * thing available to render was `message`, which is the API's own English
 * ("A discount with code SAVE10 already exists.") written for a log. Printing it
 * would break the never-render-a-server-message rule AND leave a Spanish
 * operator reading English; saying "something went wrong" instead would hide the
 * one fact that tells them what to do — that the code is taken.
 *
 * Because the `Record` is total over the union, adding an `ErrorCode` to
 * @akai/contracts fails to compile here until somebody writes the copy for it.
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

export function DiscountEditor({
  discount,
  cancelHref = "/admin/discounts",
  affiliates,
}: DiscountEditorProps) {
  const t = useTranslations("admin.discounts");
  const router = useRouter();
  const [error, setError] = useState<string | undefined>(undefined);

  /*
   * ARCHIVING IS A FOOTER SLOT NOW, NOT A PANEL BELOW THE FORM.
   *
   * X-23 drew it as an inline red box under a rule at the bottom of the page —
   * a "danger zone" that shouted at every operator who ever opened a coupon,
   * including the ones who came to change a date. The rule survives, as the
   * footer's own top border; the shouting does not. What replaces it is
   * PLACEMENT: the destructive control sits at the far left of the same row as
   * Guardar, which is the arrangement macOS uses for exactly this, and the
   * confirmation behind it still demands the code be typed out.
   *
   * IT IS RENDERED ONLY WHEN THERE IS SOMETHING TO ARCHIVE. Hidden rather than
   * disabled on an already-archived code: the API's soft delete is idempotent
   * and 404s on a second call, so the button could only ever produce a
   * confusing error.
   */
  const archiveAction =
    discount === undefined || discount.deletedAt !== null ? undefined : (
      <TypeToConfirmButton
        phrase={discount.code}
        triggerLabel={t("delete.trigger")}
        title={t("delete.title")}
        body={t("delete.body")}
        // `t.rich`, because the phrase the operator must type is rendered
        // monospaced INSIDE the sentence — and the callback lives here rather
        // than in the dialog because only this component knows the namespace
        // the copy is in.
        prompt={t.rich("delete.prompt", {
          phrase: discount.code,
          mono: (chunks) => <span className="font-mono font-semibold">{chunks}</span>,
        })}
        confirmLabel={t("delete.confirm")}
        busyLabel={t("delete.busy")}
        cancelLabel={t("delete.cancel")}
        fallbackError={t("delete.fallback")}
        onConfirm={async () => {
          const archived = await deleteDiscountAction(discount.id);
          if (!archived.ok) {
            // Thrown so the dialog stays open and shows why — with the
            // TRANSLATED text, not the API's.
            throw new ConfirmActionError(t(actionErrorKey(archived.code)));
          }
          router.push("/admin/discounts");
          router.refresh();
        }}
      />
    );

  return (
    /*
      The failure is handed DOWN as `formError` rather than rendered here.
      `DiscountForm` already owns an alert region wired to the form's
      `aria-describedby`, and rendering a second one above it would announce
      the same failure twice to a screen reader and show the operator a
      specific message stacked on top of the form's generic fallback.
    */
    <DiscountForm
      {...(discount === undefined ? {} : { discount })}
      formError={error}
      cancelHref={cancelHref}
      {...(affiliates === undefined ? {} : { affiliates })}
      {...(archiveAction === undefined ? {} : { dangerAction: archiveAction })}
      onSubmit={async (submitted) => {
        setError(undefined);

        if (submitted.mode === "create") {
          const created = await createDiscountAction(submitted.value);
          if (!created.ok) {
            // Translated from the CODE. `created.message` is deliberately NOT
            // read: it is the server's English, written for a log, and the
            // never-render-a-server-message rule forbids showing it. Returning
            // rather than throwing keeps this the only message the operator
            // sees — a throw would additionally trip the form's own generic
            // catch.
            setError(t(actionErrorKey(created.code)));
            return;
          }
          router.push(`/admin/discounts/${created.data.id}`);
          return;
        }

        if (discount === undefined) {
          return;
        }

        const updated = await updateDiscountAction(discount.id, submitted.value);
        if (!updated.ok) {
          setError(t(actionErrorKey(updated.code)));
          return;
        }
        router.refresh();
      }}
    />
  );
}
