import { NextResponse, type NextRequest } from "next/server";
import { idSchema, localeSchema } from "@akai/contracts";
import { z } from "zod";

import { apiBaseUrl } from "@/lib/api/client";
import { createAdminRawHttp, labelDownloadUrl } from "@/lib/admin/fulfilment-api";
import { AdminApiError } from "@/lib/admin/http";
import { getSession } from "@/lib/session/server";

/**
 * `GET /api/admin/shipments/:shipmentId/label?order=AK-…&locale=es`
 *
 * "Descargar etiqueta" is a PLAIN LINK (`target="_blank"`) to this handler,
 * which asks the API for the label with the bearer from the sealed session and
 * passes its 302 on to the browser — straight to a short-lived signed URL on
 * the private bucket. A link rather than a server action because an action's
 * answer arrives after an `await`, and a new tab opened then is a popup the
 * browser blocks.
 *
 * NO TOKEN MATERIAL LEAVES: the browser receives only the signed object URL,
 * scoped to one PDF and a few minutes. GET, and no CSRF pair, on purpose — it
 * changes nothing, and the most a forged cross-site navigation achieves is to
 * show a staff member a label they may already see. Authorisation is the
 * API's (STAFF/ADMIN, re-read from the session row on every request).
 *
 * On failure it returns the operator to the order with `?labelError=<code>`,
 * which the page renders from the message catalogue — never the API's English.
 */

const querySchema = z.object({
  order: z.string().regex(/^AK-\d{4}-\d{6}$/),
  locale: localeSchema.catch("es"),
});

function orderPage(request: NextRequest, locale: string, orderNumber: string, error: string): URL {
  // `as-needed` locale prefix: Spanish lives at the root.
  const prefix = locale === "es" ? "" : `/${locale}`;
  const url = new URL(`${prefix}/admin/orders/${orderNumber}`, request.nextUrl.origin);
  url.searchParams.set("labelError", error);
  return url;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ shipmentId: string }> },
): Promise<NextResponse> {
  const { shipmentId: rawId } = await context.params;
  const shipmentId = idSchema.safeParse(rawId);
  const query = querySchema.safeParse({
    order: request.nextUrl.searchParams.get("order"),
    locale: request.nextUrl.searchParams.get("locale") ?? "es",
  });
  if (!shipmentId.success || !query.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid label request." } },
      { status: 400 },
    );
  }

  const session = await getSession();
  try {
    const url = await labelDownloadUrl(
      createAdminRawHttp(apiBaseUrl(), session?.accessToken ?? null),
      shipmentId.data,
    );
    const response = NextResponse.redirect(url, 302);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (cause) {
    const code =
      cause instanceof AdminApiError ? (cause.reason ?? cause.code) : "INTERNAL_ERROR";
    return NextResponse.redirect(orderPage(request, query.data.locale, query.data.order, code), 303);
  }
}
