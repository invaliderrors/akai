import { getTranslations } from "next-intl/server";
import {
  ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR,
  DESTINATION_COUNTRY_CODES,
  type AdminShippingZoneDetail,
} from "@akai/contracts";

import { AdminErrorState } from "@/components/admin/admin-error-state";
import { ShippingManager } from "@/components/admin/shipping-manager";
import { PageTemplate } from "@/components/shell/page-template";
import {
  createShippingRateAction,
  createShippingZoneAction,
  deleteShippingRateAction,
  deleteShippingZoneAction,
  updateShippingRateAction,
  updateShippingZoneAction,
} from "@/lib/admin/actions";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { listShippingZones } from "@/lib/admin/shipping-api";
import { createServerApiClient } from "@/lib/api/client";

/**
 * Shipping zones and rates — staff-editable.
 *
 * A server component that reads `GET /admin/shipping/zones` once and hands the
 * list to ONE client boundary, the category-manager shape: a store has a
 * handful of zones, so every zone, country and rate fits on one screen.
 *
 * COUNTRY NAMES ARE RESOLVED HERE, ON THE SERVER, and passed down as plain
 * strings. `Intl.DisplayNames` answers from the runtime's ICU data, which
 * differs between Node and a Safari browser; computing the names once, in one
 * runtime, and serialising them means the client never recomputes them and the
 * hydration mismatch the storefront hit (`countries.data.ts`) cannot happen.
 */
export const dynamic = "force-dynamic";

function countryNamesFor(locale: string): Readonly<Record<string, string>> {
  const display = new Intl.DisplayNames([locale === "en" ? "en" : "es"], { type: "region" });
  const names: Record<string, string> = {};
  for (const code of DESTINATION_COUNTRY_CODES) {
    names[code] = display.of(code) ?? code;
  }
  return names;
}

export default async function AdminShippingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin.shipping");
  const http = createAdminHttp(await createServerApiClient());

  let zones: readonly AdminShippingZoneDetail[];
  try {
    zones = (await listShippingZones(http)).zones;
  } catch (cause: unknown) {
    return (
      <PageTemplate width="admin" title={t("title")} description={t("description")}>
        <AdminErrorState cause={cause} title={t("loadErrorTitle")} />
      </PageTemplate>
    );
  }

  return (
    <PageTemplate width="admin" title={t("title")} description={t("description")}>
      <ShippingManager
        initialZones={zones}
        countryNames={countryNamesFor(locale)}
        advertisedThreshold={ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR}
        onCreateZone={createShippingZoneAction}
        onUpdateZone={updateShippingZoneAction}
        onDeleteZone={deleteShippingZoneAction}
        onCreateRate={createShippingRateAction}
        onUpdateRate={updateShippingRateAction}
        onDeleteRate={deleteShippingRateAction}
      />
    </PageTemplate>
  );
}
