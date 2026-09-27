import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ActionResult } from "@/lib/admin/actions";
import type { AdminAffiliateLink, CreateAffiliateLinkRequest } from "@/lib/admin/schemas";
import esMessages from "../../../messages/es.json";

/**
 * A SEPARATE FILE, not a case inside `partner-links-manager.test.tsx` —
 * `vi.mock("@/lib/env", ...)` is hoisted once per file, so exercising a
 * different `publicEnv.storeUrl` value needs its own module graph.
 *
 * WHY THIS CASE EXISTS AT ALL: `NEXT_PUBLIC_SITE_URL` went unset on the
 * dashboard's production deployment, and the component's old fallback
 * (`/${slug}`, a relative href) silently resolved against the DASHBOARD's
 * own origin when an admin clicked it — a partner link that looked real and
 * 404'd on app.akai.shop instead of working on akai.shop. This pins
 * the fix: missing config must render as obviously broken, never as a
 * plausible-looking wrong URL.
 */
vi.mock("@/lib/admin/actions", () => ({
  createAffiliateLinkAction:
    vi.fn<(affiliateId: string, input: CreateAffiliateLinkRequest) => Promise<ActionResult<AdminAffiliateLink>>>(),
  deleteAffiliateLinkAction: vi.fn<(affiliateId: string, linkId: string) => Promise<ActionResult<null>>>(),
}));

vi.mock("@/lib/env", () => ({
  publicEnv: { storeUrl: "" },
}));

const { PartnerLinksManager } = await import("./partner-links-manager");

const AFFILIATE_ID = "88888888-8888-4888-8888-888888888888";
const LINKS: readonly AdminAffiliateLink[] = [
  {
    id: "77777777-7777-4777-8777-777777777777",
    affiliateId: AFFILIATE_ID,
    slug: "ana-recovers",
    clickCount: 12,
    createdAt: "2026-07-20T10:00:00.000Z",
    deletedAt: null,
  },
];

function renderManager() {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <PartnerLinksManager affiliateId={AFFILIATE_ID} initial={LINKS} />
    </NextIntlClientProvider>,
  );
}

describe("<PartnerLinksManager /> with no NEXT_PUBLIC_SITE_URL configured", () => {
  it("shows a loud warning instead of staying quiet", () => {
    renderManager();
    expect(screen.getByText(/URL de la tienda no está configurada/)).toBeInTheDocument();
  });

  it("renders the slug as plain text, NEVER a same-origin relative link", () => {
    renderManager();
    // The exact bug this pins: a relative href like "/ana-recovers" would
    // resolve against the dashboard's own origin when clicked.
    expect(screen.queryByRole("link", { name: /ana-recovers/ })).not.toBeInTheDocument();
    expect(screen.getByText("/ana-recovers")).toBeInTheDocument();
  });
});
