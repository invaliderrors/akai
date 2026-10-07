import { getTranslations } from "next-intl/server";
import { createServerApiClient } from "@/lib/api/client";
import { createAccountApi } from "@/lib/account";
import { Badge } from "@/components/ui/badge";
import { GroupedList, ValueRow } from "@/components/ui/grouped-list";
import { PageTemplate } from "@/components/shell/page-template";
import { PasswordForm } from "@/components/account/password-form";
import { AccountErrorPanel } from "@/components/account/account-error-panel";
import { changePasswordAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * Security settings.
 *
 * Two-step verification is stated as a FACT and nothing more. It is read from
 * `customer.twoFactorEnabled` — the only two-step field the self view carries —
 * and both positions are labelled, because the artboard draws only the "On"
 * state and a row that renders nothing when the answer is "no" reads as a row
 * that failed to load. Neutral for off: not being enrolled is not a fault, and
 * a warning tint would raise an alarm about a feature the account area cannot
 * yet offer to fix. There is no domain for it in `lib/status` — the twelve
 * badged vocabularies are all enums off the wire and this is a boolean — so the
 * tone and label are named here rather than resolved.
 *
 * There is deliberately NO enrolment link and NO device list. `GET /auth/sessions`
 * and TOTP enrolment are auth-shell surfaces that mount alongside this one; they
 * are not stubbed here, because an empty "Devices" heading reads as a broken
 * feature rather than an absent one, and a link to a screen that does not exist
 * is worse than the sentence that admits it.
 */
export default async function SecurityPage() {
  const t = await getTranslations("account.security");
  const account = createAccountApi(await createServerApiClient());

  const profile = await account.getProfile();

  if (!profile.ok) {
    return <AccountErrorPanel title={t("title")} error={profile.error} />;
  }

  const twoStepEnabled = profile.data.twoFactorEnabled;

  return (
    <PageTemplate width="reading" title={t("title")} description={t("subtitle")}>
      <div className="grid gap-5">
        <GroupedList
          id="security-sign-in"
          label={t("signInSection")}
          hint={twoStepEnabled ? t("twoStepHint") : t("twoStepOffHint")}
        >
          <ValueRow
            label={t("twoStep")}
            value={
              <Badge
                tone={twoStepEnabled ? "success" : "neutral"}
                label={twoStepEnabled ? t("twoStepOn") : t("twoStepOff")}
              />
            }
          />
        </GroupedList>

        <PasswordForm onSubmit={changePasswordAction} />
      </div>
    </PageTemplate>
  );
}
