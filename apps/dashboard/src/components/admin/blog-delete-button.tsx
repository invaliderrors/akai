"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { ConfirmActionError, ConfirmAlert } from "@/components/ui/confirm";
import { useRouter } from "next/navigation";
import { deleteBlogPostAction } from "@/lib/admin/actions";

import { actionErrorKey } from "./affiliate-editor";

/**
 * Delete a post from the list, behind a confirmation that NAMES the post.
 *
 * `ConfirmAlert` rather than the type-to-confirm dialog the edit page uses:
 * from a row the operator is one misclick away from the wrong post, and the
 * alert's required `item` line is what says which one — but typing a slug to
 * delete a blog draft from a list would be ceremony out of proportion to the
 * harm. The edit page keeps the heavier dialog, where the post is the page.
 */
export interface BlogDeleteButtonProps {
  readonly postId: string;
  readonly title: string;
}

export function BlogDeleteButton({ postId, title }: BlogDeleteButtonProps) {
  const t = useTranslations("admin.blog");
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="standard" size="compact" onClick={() => setOpen(true)}>
        {t("delete.rowTrigger")}
      </Button>
      <ConfirmAlert
        open={open}
        onClose={() => setOpen(false)}
        title={t("delete.title")}
        item={title}
        consequence={t("delete.body")}
        confirmLabel={t("delete.confirm")}
        cancelLabel={t("delete.cancel")}
        busyLabel={t("delete.busy")}
        fallbackError={t("delete.fallback")}
        density="compact"
        onConfirm={async () => {
          const result = await deleteBlogPostAction(postId);
          if (!result.ok) throw new ConfirmActionError(t(actionErrorKey(result.code)));
          router.refresh();
        }}
      />
    </>
  );
}
