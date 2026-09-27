"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { publicEnv } from "@/lib/env";
import { createAffiliateLinkAction, deleteAffiliateLinkAction } from "@/lib/admin/actions";
import type { AdminAffiliateLink } from "@/lib/admin/schemas";
import { ConfirmActionError, TypeToConfirmButton } from "./type-to-confirm-button";

export interface PartnerLinksManagerProps {
  readonly affiliateId: string;
  readonly initial: readonly AdminAffiliateLink[];
}

/**
 * Create, list and retire an affiliate's vanity links
 * (`akai.shop/<slug>`). SAME create+list+delete shape as
 * `category-manager.tsx` — no rename or reorder here, since a link's whole
 * identity IS its slug and there is nothing to reorder among a handful of
 * links.
 *
 * `clickCount` is READ-ONLY, live from the server on every create/delete —
 * it is never something this component tracks itself, matching the
 * append-only-log convention `AffiliateLinksService` documents for the click
 * table itself.
 *
 * IMPORTS ITS ACTIONS DIRECTLY, same reasoning as `PartnerLoginPanel`.
 */
export function PartnerLinksManager({ affiliateId, initial }: PartnerLinksManagerProps) {
  const t = useTranslations("admin.affiliates.partnerLinks");
  const [rows, setRows] = useState<readonly AdminAffiliateLink[]>(initial);

  const [slug, setSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setCreateError(undefined);
    setCreating(true);
    try {
      const result = await createAffiliateLinkAction(affiliateId, { slug: slug.trim() });
      if (!result.ok) {
        setCreateError(result.code === "CONFLICT" ? t("duplicateSlug") : t("createFailed"));
        return;
      }
      setRows((current) => [result.data, ...current]);
      setSlug("");
    } finally {
      setCreating(false);
    }
  }

  // NEVER a relative fallback (`/${slug}`) here. This component renders on
  // the DASHBOARD's own origin, and a relative href resolves against THAT
  // origin — an admin who copies a link built that way hands a partner a
  // URL that silently 404s on app.akai.shop instead of working on
  // akai.shop. Missing config must look obviously broken, not plausible.
  const hasStoreUrl = publicEnv.storeUrl !== "";

  function urlFor(slugValue: string): string {
    return `${publicEnv.storeUrl}/${slugValue}`;
  }

  return (
    <div className="grid gap-4 rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-[var(--card-p)]">
      <h2 className="m-0 text-[13px] font-semibold text-[var(--label)]">{t("title")}</h2>
      <p className="m-0 text-[12px] text-[var(--label-secondary)]">{t("description")}</p>

      {!hasStoreUrl && <Notice tone="danger">{t("storeUrlMissing")}</Notice>}

      <form onSubmit={(event) => void handleCreate(event)} className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <TextField
          label={t("slugLabel")}
          name="slug"
          id="partner-link-slug"
          value={slug}
          onChange={setSlug}
          hint={t("slugHint")}
          required
          disabled={creating}
        />
        <div className="self-end justify-self-start sm:justify-self-end">
          <Button type="submit" variant="prominent" size="compact" disabled={creating}>
            {creating ? t("creating") : t("create")}
          </Button>
        </div>
      </form>
      {createError !== undefined && <Notice tone="danger">{createError}</Notice>}

      {rows.length === 0 ? (
        <Notice tone="warning">{t("empty")}</Notice>
      ) : (
        <ol className="grid gap-1.5">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-card)] border border-[var(--separator-weak)] bg-[var(--bg-grouped)] p-2"
            >
              <div className="min-w-0">
                {hasStoreUrl ? (
                  <a
                    href={urlFor(row.slug)}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate font-mono text-[12px] text-[var(--accent)] hover:underline"
                  >
                    {urlFor(row.slug)}
                  </a>
                ) : (
                  <span className="truncate font-mono text-[12px] text-[var(--label)]">
                    /{row.slug}
                  </span>
                )}
                <p className="m-0 text-[11px] text-[var(--label-secondary)]">
                  {t("clickCount", { count: row.clickCount })}
                </p>
              </div>
              <TypeToConfirmButton
                phrase={row.slug}
                triggerLabel={t("deleteTrigger")}
                title={t("deleteTitle")}
                body={t("deleteBody")}
                prompt={t.rich("deletePrompt", {
                  phrase: row.slug,
                  mono: (chunks) => <span className="font-mono font-semibold">{chunks}</span>,
                })}
                confirmLabel={t("deleteConfirm")}
                busyLabel={t("deleteBusy")}
                cancelLabel={t("deleteCancel")}
                fallbackError={t("deleteFailed")}
                onConfirm={async () => {
                  const result = await deleteAffiliateLinkAction(affiliateId, row.id);
                  if (!result.ok) {
                    throw new ConfirmActionError(t("deleteFailed"));
                  }
                  setRows((current) => current.filter((entry) => entry.id !== row.id));
                }}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
