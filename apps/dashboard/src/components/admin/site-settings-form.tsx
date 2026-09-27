"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Checkbox } from "@/components/ui/toggle";
import type { ActionResult } from "@/lib/admin/actions";

/**
 * The site-wide admin settings — today, exactly one toggle.
 *
 * §2 of `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`.
 * The SAVE BUTTON IS DISABLED UNTIL THE VALUE ACTUALLY CHANGES, same
 * reasoning `product-reorder-list.tsx`'s own save bar gives for its
 * success/failure notices: a control that is always clickable invites a
 * confirmed-but-nothing-changed click that teaches an operator the button
 * cannot be trusted.
 *
 * NO PREVIEW OF WHAT MAINTENANCE MODE DOES. The storefront's own middleware
 * (`apps/storefront/src/middleware.ts`) picks the flag up within its own
 * short TTL — a few seconds — not instantly, and this form says so rather
 * than implying the toggle takes effect the moment the checkbox is ticked;
 * it does not take effect until Guardar is pressed at all.
 */
export interface SiteSettingsFormProps {
  readonly initialMaintenanceMode: boolean;
  readonly onSave: (input: {
    maintenanceMode: boolean;
  }) => Promise<ActionResult<{ maintenanceMode: boolean }>>;
}

export function SiteSettingsForm({ initialMaintenanceMode, onSave }: SiteSettingsFormProps) {
  const t = useTranslations("admin.siteSettings");
  const [maintenanceMode, setMaintenanceMode] = useState(initialMaintenanceMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const dirty = maintenanceMode !== initialMaintenanceMode;

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      const result = await onSave({ maintenanceMode });
      if (!result.ok) {
        setError(t("saveFailed"));
        return;
      }
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4">
      <section className="grid gap-2 rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-[var(--card-p)]">
        <h2 className="m-0 text-[13px] font-semibold text-[var(--label)]">
          {t("maintenanceTitle")}
        </h2>
        <p className="m-0 text-[12px] leading-4 text-[var(--label-secondary)]">
          {t("maintenanceHint")}
        </p>
        <Checkbox
          label={t("maintenanceModeLabel")}
          name="maintenance-mode"
          checked={maintenanceMode}
          onChange={(checked) => {
            setMaintenanceMode(checked);
            setSaved(false);
          }}
          disabled={saving}
        />
        {maintenanceMode && <Notice tone="warning">{t("maintenanceActiveWarning")}</Notice>}
      </section>

      {error !== undefined && <Notice tone="danger">{error}</Notice>}
      {saved && <Notice tone="success">{t("saveSuccess")}</Notice>}

      <div className="justify-self-start">
        <Button
          variant="prominent"
          size="compact"
          disabled={saving || !dirty}
          onClick={() => void handleSave()}
        >
          {saving ? t("saving") : t("save")}
        </Button>
      </div>
    </div>
  );
}
