import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { AdminApiError } from "@/lib/admin/http";
import esMessages from "../../../../../../../messages/es.json";

/**
 * The edit page's 404 branch.
 *
 * WHAT IS ACTUALLY UNDER TEST: that a missing coupon becomes Next's `notFound()`
 * and that everything else does not. The page keys that decision on the API's
 * `code` — a member of the platform's CLOSED `ErrorCode` enum — rather than on
 * the HTTP status, because the status is a derived projection of the code
 * (`ERROR_STATUS` in @akai/contracts) and any proxy between here and the API is
 * free to invent one. A cache returning a bare 404 with no envelope must land in
 * the error panel, not tell the operator their coupon has been deleted.
 */

const notFound = vi.fn(() => {
  // Throws, exactly as the real one does: `notFound()` works by raising a
  // control-flow signal Next catches, so a no-op mock would let execution fall
  // through and hide the very branch this file exists to pin.
  throw new Error("NEXT_NOT_FOUND");
});

/**
 * Typed, not bare `vi.fn()`: an untyped mock returns `any`, and threading that
 * through the module factory below is an `no-unsafe-return` lint error — the
 * repo bans `any` in tests exactly as it does in source.
 */
const getDiscount = vi.fn<(http: unknown, id: string) => Promise<unknown>>();

vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

vi.mock("next-intl/server", () => ({
  // Identity translator: the assertions are about which message KEY the page
  // reaches for, not about the Spanish copy behind it (that is the catalogue
  // parity test's job).
  getTranslations: async () => (key: string) => key,
}));

vi.mock("@/lib/api/client", () => ({ createServerApiClient: async () => ({}) }));
vi.mock("@/lib/admin/http-adapter", () => ({ createAdminHttp: () => ({}) }));
vi.mock("@/lib/admin/api", () => ({
  getDiscount: (http: unknown, id: string) => getDiscount(http, id),
  // Only fetched so `DiscountEditor` can render an affiliate picker — mocked
  // away below, so the response shape here is not itself under test.
  listAffiliates: async () => ({ items: [], hasMore: false, nextCursor: null }),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}));

vi.mock("@/components/admin/discount-editor", () => ({
  DiscountEditor: () => <div data-testid="discount-editor" />,
}));

const { default: EditDiscountPage } = await import("./page");

const DISCOUNT_ID = "77777777-7777-4777-8777-777777777777";

function params() {
  return Promise.resolve({ locale: "es", id: DISCOUNT_ID });
}

/**
 * `next-intl/server` is mocked to an identity translator, so everything the
 * PAGE says is its own message KEY. The kit components it now composes —
 * `StatusBadge`, `Notice`, `ErrorState` — reach the CLIENT translator instead,
 * which needs a real provider; they get the real catalogue rather than a second
 * mock, so a badge that asks for a key nobody wrote fails here too.
 */
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

describe("EditDiscountPage", () => {
  beforeEach(() => {
    notFound.mockClear();
    getDiscount.mockReset();
  });

  it("calls notFound() when the API's code is NOT_FOUND", async () => {
    getDiscount.mockRejectedValue(apiError("NOT_FOUND", 404));

    await expect(EditDiscountPage({ params: params() })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("does NOT call notFound() for a 404 that carries no error envelope", async () => {
    // `toApiError` synthesises INTERNAL_ERROR when the body is not the documented
    // envelope — a proxy timing out returns HTML. Status-based branching would
    // report that to the operator as "this coupon no longer exists", which is a
    // claim about their data that nothing here has verified.
    getDiscount.mockRejectedValue(apiError("INTERNAL_ERROR", 404));

    const page = await EditDiscountPage({ params: params() });
    renderPage(page);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("detailErrorTitle");
  });

  it("renders a translated error panel for any other failure", async () => {
    getDiscount.mockRejectedValue(apiError("FORBIDDEN", 403));

    const page = await EditDiscountPage({ params: params() });
    renderPage(page);

    expect(notFound).not.toHaveBeenCalled();
    // The panel says what failed in the page's own words (a KEY here) and
    // explains it from the closed `ErrorCode`, never from the API's own
    // "server-authored english" — that string must not reach an operator.
    expect(screen.getByRole("alert")).toHaveTextContent("detailErrorTitle");
    expect(screen.queryByText(/server-authored english/)).toBeNull();
  });

  it("renders the editor when the coupon loads", async () => {
    getDiscount.mockResolvedValue({
      id: DISCOUNT_ID,
      code: "SAVE10",
      type: "PERCENTAGE",
      value: 1000,
      minimumSubtotal: null,
      currency: null,
      maxRedemptions: null,
      maxRedemptionsPerCustomer: null,
      timesRedeemed: 4,
      remainingRedemptions: null,
      stackable: false,
      startsAt: null,
      endsAt: null,
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-21T10:00:00.000Z",
      deletedAt: null,
    });

    const page = await EditDiscountPage({ params: params() });
    renderPage(page);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("discount-editor")).toBeInTheDocument();
    // The state badge reads from the shared `status` vocabulary, so an operator
    // never meets a raw enum member: ARCHIVED would say "Archivado" here.
    expect(screen.getByText("Activo")).toBeInTheDocument();
    // Usage is the first thing an operator opening a coupon wants to know.
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("unlimited")).toBeInTheDocument();
  });
});
