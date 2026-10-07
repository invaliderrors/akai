import { getTranslations } from "next-intl/server";
import { createServerApiClient } from "@/lib/api/client";
import { createAccountApi } from "@/lib/account";
import { PageTemplate } from "@/components/shell/page-template";
import { ProfileForm } from "@/components/account/profile-form";
import { AccountErrorPanel } from "@/components/account/account-error-panel";
import { updateProfileAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * Profile.
 *
 * Fetched here and passed down as a plain prop: the form is a client component
 * only because it holds draft state, and the customer it edits has no business
 * being fetched twice on the way to it.
 *
 * No `.card` wrapper. The form owns an inset grouped list, which is its own
 * card — nesting it in a second one draws a frame inside a frame.
 */
export default async function ProfilePage() {
  const t = await getTranslations("account.profile");
  const account = createAccountApi(await createServerApiClient());

  const profile = await account.getProfile();

  if (!profile.ok) {
    return <AccountErrorPanel title={t("title")} error={profile.error} />;
  }

  return (
    <PageTemplate width="reading" title={t("title")} description={t("subtitle")}>
      <ProfileForm customer={profile.data} onSave={updateProfileAction} />
    </PageTemplate>
  );
}
