"use client";

import { useTranslations } from "next-intl";

import { TypeToConfirmButton } from "./type-to-confirm-button";

export interface DeleteProductButtonProps {
  readonly productSlug: string;
  readonly onConfirm: () => Promise<void>;
}

/**
 * Soft-delete a product behind a typed confirmation.
 *
 * The interaction lives in `TypeToConfirmButton` (and, below that, in
 * `ui/confirm`); this file is the product-specific COPY and nothing else.
 * Keeping it as a named component rather than inlining the generic one at each
 * call site means the wording — in particular the "you can restore it
 * afterwards" sentence — is stated once and cannot drift between the product
 * list and the product editor.
 *
 * WHAT THIS IS NOT: destructive. The API soft-deletes (`deletedAt` + ARCHIVED)
 * and offers a restore, because orders and invoices reference products forever.
 * The copy says so rather than implying the data is gone, so an operator who
 * genuinely needs a hard delete goes and asks instead of assuming this did it.
 *
 * THE COPY IS TRANSLATED NOW. The previous revision carried hardcoded English
 * and a comment recording it as "awaiting the sweep that translates the whole
 * admin area at once" — this is that sweep. `admin.productForm.delete.*` is the
 * one namespace the strings live in; nothing here is written twice.
 *
 * THE PHRASE IS THE SLUG, still. A two-button dialog is dismissed by muscle
 * memory; typing the record's own identifier forces the operator to read WHICH
 * product they are on, and the likeliest mistake by far is the right-looking row
 * on the wrong page.
 */
export function DeleteProductButton({ productSlug, onConfirm }: DeleteProductButtonProps) {
  const t = useTranslations("admin.productForm");

  return (
    <TypeToConfirmButton
      phrase={productSlug}
      triggerLabel={t("delete.trigger")}
      title={t("delete.title")}
      body={t("delete.body")}
      prompt={t.rich("delete.prompt", {
        phrase: productSlug,
        // The chunk callback places the mono chip INSIDE the sentence, which is
        // the only way word order survives translation: "Escribe X para
        // confirmar" and "Type X to confirm" put the phrase in different places
        // and a concatenated string can only be right in one of them.
        mono: (chunks) => <span className="font-mono font-semibold">{chunks}</span>,
      })}
      confirmLabel={t("delete.confirm")}
      busyLabel={t("delete.busy")}
      cancelLabel={t("delete.cancel")}
      fallbackError={t("delete.fallback")}
      onConfirm={onConfirm}
    />
  );
}
