import { getTranslations } from "next-intl/server";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { SiteSettingsForm } from "@/components/admin/site-settings-form";
import { PageTemplate } from "@/components/shell/page-template";
import { createServerApiClient } from "@/lib/api/client";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { getSiteSettings } from "@/lib/admin/api";
import { updateSiteSettingsAction } from "@/lib/admin/actions";

/**
 * The site-wide admin settings — today, exactly maintenance mode.
 *
 * §2 of `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`.
 * `GET /v1/site-settings` is the SAME public endpoint the storefront's own
 * middleware polls; this page just reads it through the authenticated admin
 * client for consistency with every other admin read, not because the value
 * itself needs a session to see.
 */
export default async function AdminSettingsPage() {
  const t = await getTranslations("admin.siteSettings");
  const http = createAdminHttp(await createServerApiClient());

  let maintenanceMode = false;
  let loadError: unknown = null;
  try {
    maintenanceMode = (await getSiteSettings(http)).maintenanceMode;
  } catch (error: unknown) {
    loadError = error;
  }

  return (
    <PageTemplate width="admin" title={t("title")} description={t("description")}>
      {loadError !== null ? (
        <AdminErrorState cause={loadError} title={t("loadErrorTitle")} />
      ) : (
        <SiteSettingsForm
          initialMaintenanceMode={maintenanceMode}
          onSave={updateSiteSettingsAction}
        />
      )}
    </PageTemplate>
  );
}
