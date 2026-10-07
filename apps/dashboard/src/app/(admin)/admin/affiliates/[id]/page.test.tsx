import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { AdminApiError } from "@/lib/admin/http";
import esMessages from "../../../../../../messages/es.json";

/**
 * The affiliate edit page's 404 branch. Mirrors
 * `admin/discounts/[id]/page.test.tsx` exactly — see its own doc comment for
 * why the branch keys on the API's `code` rather than the HTTP status.
 */

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

const getAffiliate = vi.fn<(http: unknown, id: string) => Promise<unknown>>();
const listAffiliateLinks = vi.fn<(http: unknown, id: string) => Promise<unknown>>();

vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

vi.mock("@/lib/api/client", () => ({ createServerApiClient: async () => ({}) }));
vi.mock("@/lib/admin/http-adapter", () => ({ createAdminHttp: () => ({}) }));
vi.mock("@/lib/admin/api", () => ({
  getAffiliate: (http: unknown, id: string) => getAffiliate(http, id),
  listAffiliateLinks: (http: unknown, id: string) => listAffiliateLinks(http, id),
}));

vi.mock("next/link", () => ({
  default: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}));

vi.mock("@/components/admin/affiliate-editor", () => ({
  AffiliateEditor: () => <div data-testid="affiliate-editor" />,
}));

vi.mock("@/components/admin/partner-login-panel", () => ({
  PartnerLoginPanel: () => <div data-testid="partner-login-panel" />,
}));

vi.mock("@/components/admin/partner-links-manager", () => ({
  PartnerLinksManager: () => <div data-testid="partner-links-manager" />,
}));

const { default: EditAffiliatePage } = await import("./page");

const AFFILIATE_ID = "88888888-8888-4888-8888-888888888888";

function params() {
  return Promise.resolve({ id: AFFILIATE_ID });
}

function renderPage(page: ReactNode) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {page}
    </NextIntlClientProvider>,
  );
}

function apiError(code: AdminApiError["code"], status: number): AdminApiError {
  return new AdminApiError({ code, status, message: "server-authored english" });
}

function affiliateBody(overrides: Record<string, unknown> = {}) {
  return {
    id: AFFILIATE_ID,
    name: "Ana",
    country: "ES",
    socialHandle: "@ana",
    email: "ana@example.com",
    discountCodes: ["SAVE10"],
    redemptionCount: 3,
    revenueMinor: 14997,
    hasLogin: false,
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("EditAffiliatePage", () => {
  beforeEach(() => {
    notFound.mockClear();
    getAffiliate.mockReset();
    listAffiliateLinks.mockReset();
    listAffiliateLinks.mockResolvedValue([]);
  });

  it("calls notFound() when the API's code is NOT_FOUND", async () => {
    getAffiliate.mockRejectedValue(apiError("NOT_FOUND", 404));

    await expect(EditAffiliatePage({ params: params() })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("does NOT call notFound() for a 404 that carries no error envelope", async () => {
    getAffiliate.mockRejectedValue(apiError("INTERNAL_ERROR", 404));

    const page = await EditAffiliatePage({ params: params() });
    renderPage(page);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("detailErrorTitle");
  });

  it("renders a translated error panel for any other failure, never the API's own English", async () => {
    getAffiliate.mockRejectedValue(apiError("FORBIDDEN", 403));

    const page = await EditAffiliatePage({ params: params() });
    renderPage(page);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("detailErrorTitle");
    expect(screen.queryByText(/server-authored english/)).toBeNull();
  });

  it("renders the editor and the derived stats when the affiliate loads", async () => {
    getAffiliate.mockResolvedValue(affiliateBody());

    const page = await EditAffiliatePage({ params: params() });
    renderPage(page);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("affiliate-editor")).toBeInTheDocument();
    expect(screen.getByText("state.ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("SAVE10")).toBeInTheDocument();
  });

  it("shows the archived badge and notice for a soft-deleted affiliate", async () => {
    getAffiliate.mockResolvedValue(
      affiliateBody({ deletedAt: "2026-08-01T10:00:00.000Z" }),
    );

    const page = await EditAffiliatePage({ params: params() });
    renderPage(page);

    expect(screen.getByText("state.ARCHIVED")).toBeInTheDocument();
    expect(screen.getByText("archivedNotice")).toBeInTheDocument();
  });
});
