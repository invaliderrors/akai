import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ActionResult } from "@/lib/admin/actions";
import type { AdminAffiliateLink, CreateAffiliateLinkRequest } from "@/lib/admin/schemas";
import esMessages from "../../../messages/es.json";

const createAffiliateLinkAction = vi.fn<
  (affiliateId: string, input: CreateAffiliateLinkRequest) => Promise<ActionResult<AdminAffiliateLink>>
>();
const deleteAffiliateLinkAction =
  vi.fn<(affiliateId: string, linkId: string) => Promise<ActionResult<null>>>();

vi.mock("@/lib/admin/actions", () => ({
  createAffiliateLinkAction: (affiliateId: string, input: CreateAffiliateLinkRequest) =>
    createAffiliateLinkAction(affiliateId, input),
  deleteAffiliateLinkAction: (affiliateId: string, linkId: string) =>
    deleteAffiliateLinkAction(affiliateId, linkId),
}));

vi.mock("@/lib/env", () => ({
  publicEnv: { storeUrl: "https://akai.shop" },
}));

const { PartnerLinksManager } = await import("./partner-links-manager");

const AFFILIATE_ID = "88888888-8888-4888-8888-888888888888";
const ISO = "2026-07-20T10:00:00.000Z";

const LINKS: readonly AdminAffiliateLink[] = [
  {
    id: "77777777-7777-4777-8777-777777777777",
    affiliateId: AFFILIATE_ID,
    slug: "ana-recovers",
    clickCount: 12,
    createdAt: ISO,
    deletedAt: null,
  },
];

function renderManager(links: readonly AdminAffiliateLink[] = LINKS) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <PartnerLinksManager affiliateId={AFFILIATE_ID} initial={links} />
    </NextIntlClientProvider>,
  );
}

describe("<PartnerLinksManager />", () => {
  beforeEach(() => {
    createAffiliateLinkAction.mockReset();
    deleteAffiliateLinkAction.mockReset();
  });

  it("renders every link's full URL and click count", () => {
    renderManager();
    expect(screen.getByRole("link", { name: "https://akai.shop/ana-recovers" })).toBeInTheDocument();
    expect(screen.getByText("12 visitas")).toBeInTheDocument();
  });

  it("renders the empty state when there are no links", () => {
    renderManager([]);
    expect(screen.getByText("Todavía no hay enlaces.")).toBeInTheDocument();
  });

  it("creates a link and appends it to the list, scoped to this affiliate's id", async () => {
    createAffiliateLinkAction.mockResolvedValue({
      ok: true,
      data: {
        id: "new-link",
        affiliateId: AFFILIATE_ID,
        slug: "new-partner",
        clickCount: 0,
        createdAt: ISO,
        deletedAt: null,
      },
    });
    const user = userEvent.setup();
    renderManager([]);

    await user.type(screen.getByLabelText(/Enlace/), "new-partner");
    await user.click(screen.getByRole("button", { name: "Crear enlace" }));

    expect(createAffiliateLinkAction).toHaveBeenCalledWith(AFFILIATE_ID, { slug: "new-partner" });
    expect(
      await screen.findByRole("link", { name: "https://akai.shop/new-partner" }),
    ).toBeInTheDocument();
  });

  it("shows the duplicate-slug message, not a generic failure, on a conflict", async () => {
    createAffiliateLinkAction.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      reason: null,
      message: "server-authored english",
    });
    const user = userEvent.setup();
    renderManager([]);

    await user.type(screen.getByLabelText(/Enlace/), "checkout");
    await user.click(screen.getByRole("button", { name: "Crear enlace" }));

    expect(await screen.findByText("Este enlace ya está en uso.")).toBeInTheDocument();
    expect(screen.queryByText(/server-authored english/)).toBeNull();
  });

  it("deletes a link, scoped to this affiliate's id, once the type-to-confirm dialog succeeds", async () => {
    deleteAffiliateLinkAction.mockResolvedValue({ ok: true, data: null });
    const user = userEvent.setup();
    renderManager();

    const row = screen.getAllByRole("listitem")[0];
    if (row === undefined) throw new Error("expected a link row");

    await user.click(within(row).getByRole("button", { name: "Eliminar" }));
    await user.type(screen.getByLabelText(/Escribe/), "ana-recovers");
    await user.click(screen.getByRole("button", { name: "Eliminar enlace" }));

    expect(deleteAffiliateLinkAction).toHaveBeenCalledWith(
      AFFILIATE_ID,
      "77777777-7777-4777-8777-777777777777",
    );
    expect(await screen.findByText("Todavía no hay enlaces.")).toBeInTheDocument();
  });
});
