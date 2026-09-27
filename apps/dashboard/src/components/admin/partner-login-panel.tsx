"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { activatePartnerLoginAction } from "@/lib/admin/actions";

export interface PartnerLoginPanelProps {
  readonly affiliateId: string;
  readonly hasLogin: boolean;
  readonly email: string;
}

/**
 * One button, doing double duty by design — see
 * `AffiliateAdminService.activatePartnerLogin`'s own doc comment. Before
 * activation it creates the partner's login and mails a password-setup link;
 * afterwards the SAME action just re-sends that mail, so there is one control
 * to reason about instead of two that must stay in sync.
 *
 * IMPORTS THE ACTION DIRECTLY rather than receiving it as a prop — the same
 * choice `affiliate-editor.tsx` makes for `updateAffiliateAction`, since this
 * panel (like that editor) is scoped to one affiliate id it already holds.
 */
export function PartnerLoginPanel({ affiliateId, hasLogin, email }: PartnerLoginPanelProps) {
  const t = useTranslations("admin.affiliates.partnerLogin");
  const [active, setActive] = useState(hasLogin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sent, setSent] = useState(false);

  async function handleClick(): Promise<void> {
    setError(undefined);
    setSent(false);
    setBusy(true);
    try {
      const result = await activatePartnerLoginAction(affiliateId);
      if (!result.ok) {
        setError(result.code === "CONFLICT" ? t("conflict") : t("failed"));
        return;
      }
      setActive(true);
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-[var(--card-p)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-[13px] font-semibold text-[var(--label)]">{t("title")}</h2>
          <p className="m-0 text-[12px] text-[var(--label-secondary)]">
            {active ? t("activeDescription", { email }) : t("inactiveDescription")}
          </p>
        </div>
        <Button variant="standard" size="compact" disabled={busy} onClick={() => void handleClick()}>
          {busy ? t("busy") : active ? t("resend") : t("activate")}
        </Button>
      </div>
      {error !== undefined && <Notice tone="danger">{error}</Notice>}
      {sent && error === undefined && <Notice tone="success">{t("sent")}</Notice>}
    </div>
  );
}
