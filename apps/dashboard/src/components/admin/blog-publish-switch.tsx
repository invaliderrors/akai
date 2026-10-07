"use client";

import { useTranslations } from "next-intl";
import type { BlogPostStatus } from "@akai/contracts";

import { Switch } from "@/components/ui/toggle";
import { useRouter } from "next/navigation";
import { setBlogPostPublishedAction } from "@/lib/admin/actions";

/**
 * Publish / unpublish a post in one flip — on the list and on the edit page.
 *
 * `Switch` commits on flip, shows the new position immediately, reverts and
 * announces a failure; this only has to REJECT on failure for that to happen.
 * The storefront purge is the API's job (the publish enqueues it in the same
 * transaction), so there is nothing else to do here but refresh this page.
 */
export interface BlogPublishSwitchProps {
  readonly postId: string;
  readonly status: BlogPostStatus;
  /** The post's title, so the switch's accessible name says WHICH post. */
  readonly title: string;
  readonly labelHidden?: boolean;
}

export function BlogPublishSwitch({ postId, status, title, labelHidden = false }: BlogPublishSwitchProps) {
  const t = useTranslations("admin.blog");
  const router = useRouter();

  return (
    <Switch
      label={t("publishSwitch", { title })}
      checked={status === "PUBLISHED"}
      labelHidden={labelHidden}
      errorMessage={t("publishFailed")}
      onChange={async (checked) => {
        const result = await setBlogPostPublishedAction(postId, checked);
        if (!result.ok) throw new Error(result.message);
        router.refresh();
      }}
    />
  );
}
