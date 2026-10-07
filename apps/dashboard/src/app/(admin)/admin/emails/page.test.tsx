import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emailEventSchema, type EmailEvent } from "@akai/contracts";

import { AdminApiError } from "@/lib/admin/http";

import esMessages from "../../../../../messages/es.json";

/**
 * The delivery log.
 *
 * WHAT IS ACTUALLY UNDER TEST, in order of how much it would cost to get wrong:
 *
 *  1. THE PROVIDER'S FAILURE TEXT IS IN AN EXPANSION, NOT A TOOLTIP. It used to
 *     be an 80-character prefix with the whole string in `title` — invisible on
 *     a touch screen and unreachable from a keyboard, which is to say invisible
 *     to whoever is actually diagnosing a bounce at 2am on a phone.
 *  2. THE PANEL IS READ-ONLY. The artboard drew "Reenviar a otra dirección…",
 *     "Reenviar" and a rendered body preview beside this text. A verify-email
 *     or reset-password body carries a live single-use token, so re-rendering
 *     one — or mailing a template to an operator-chosen address — turns a
 *     diagnostics page into an account-takeover surface. The assertion is
 *     structural (the expansion contains no control at all) rather than a
 *     search for Spanish copy, because a search for copy passes the moment
 *     somebody words the button differently.
 *  3. No raw enum reaches an operator, and an unreadable `?status=` degrades to
 *     no filter instead of a 400 nobody can act on.
 *
 * The server translator is stubbed to return the KEY PATH it was asked for, so
 * these assertions name the catalogue entry the page reached for rather than
 * the Spanish behind it — which is the catalogue parity test's job. The CLIENT
 * half runs against the real `es.json`, because the badge labels are exactly
 * where a raw enum would leak and a fixture catalogue would hide it.
 */

const listEmailEvents = vi.fn<(http: unknown, params: unknown) => Promise<unknown>>();

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock("@/lib/api/client", () => ({ createServerApiClient: async () => ({}) }));
vi.mock("@/lib/admin/http-adapter", () => ({ createAdminHttp: () => ({}) }));
vi.mock("@/lib/admin/api", () => ({
  listEmailEvents: (http: unknown, params: unknown) => listEmailEvents(http, params),
}));

const { default: AdminEmailsPage } = await import("./page");

const FAILED_ID = "22222222-2222-4222-8222-222222222222";

/** Long enough that the superseded 80-character truncation would have cut it. */
const PROVIDER_ERROR =
  "550 5.1.1 <bad@invalid.example>: Recipient address rejected: User unknown in virtual mailbox table";

/**
 * Parsed through the contract rather than cast to it. A fixture that has
 * drifted from `emailEventSchema` must fail here, not pass against a shape the
 * API can no longer send — and `shipping-confirmation` is the REAL template
 * key, where the artboard drew a "shipment-dispatched" that is not a member.
 */
const EVENTS: readonly EmailEvent[] = [
  emailEventSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    recipient: "ana@example.es",
    templateKey: "order-confirmation",
    status: "DELIVERED",
    providerMessageId: "msg_9f21c4",
    orderId: null,
    error: null,
    attempts: 1,
    sentAt: "2026-08-28T14:33:00.000Z",
    createdAt: "2026-08-28T14:33:00.000Z",
  }),
  emailEventSchema.parse({
    id: FAILED_ID,
    recipient: "bad@invalid.example",
    templateKey: "shipping-confirmation",
    status: "FAILED",
    providerMessageId: null,
    orderId: null,
    error: PROVIDER_ERROR,
    attempts: 3,
    sentAt: null,
    createdAt: "2026-08-27T10:02:00.000Z",
  }),
];

function pageOf(items: readonly EmailEvent[]) {
  return { items, nextCursor: null, hasMore: false };
}

function renderPage(element: ReactElement) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {element}
    </NextIntlClientProvider>,
  );
}

async function renderList(query: Record<string, string | string[] | undefined> = {}) {
  const element = await AdminEmailsPage({
    searchParams: Promise.resolve(query),
  });
  return renderPage(element);
}

/** The params the page handed the API client on its single call. */
function requestedParams(): unknown {
  const call = listEmailEvents.mock.calls[0];
  if (call === undefined) {
    throw new Error("the page did not call listEmailEvents");
  }
  return call[1];
}

describe("AdminEmailsPage", () => {
  beforeEach(() => {
    listEmailEvents.mockReset();
    listEmailEvents.mockResolvedValue(pageOf(EVENTS));
  });

  it("labels every status through the shared vocabulary, never as the raw enum", async () => {
    await renderList();

    expect(screen.getByText("Entregado")).toBeInTheDocument();
    expect(screen.getByText("Fallido")).toBeInTheDocument();
    // PAYMENT_MISMATCH and PARTIALLY_REFUNDED reached operators verbatim on the
    // superseded screens; this is the same defect one enum over.
    expect(screen.queryByText("DELIVERED")).toBeNull();
    expect(screen.queryByText("FAILED")).toBeNull();
  });

  it("offers the status filter the same labels the badges use", async () => {
    await renderList();

    const select = screen.getByLabelText("admin.emails.statusLabel");
    // `status.email.*` — the namespace `lib/status`'s `messageKey` builds. A
    // filter that named a state differently from the rows it returns leaves an
    // operator guessing which of the two is the truth.
    expect(within(select).getByRole("option", { name: "status.email.BOUNCED" })).toBeInTheDocument();
  });

  it("keeps the provider's failure text out of the table and out of a tooltip", async () => {
    await renderList();

    expect(screen.queryByText(PROVIDER_ERROR)).toBeNull();
    // The specific regression: a `title` is invisible on touch and to a
    // keyboard, so it is not a way of showing anything.
    expect(screen.queryByTitle(PROVIDER_ERROR)).toBeNull();
    expect(screen.queryByTitle(/Recipient address rejected/)).toBeNull();
  });

  it("reveals the whole failure text when the row is expanded through the URL", async () => {
    await renderList({ expand: FAILED_ID });

    // Whole, not the first 80 characters: the tail of an SMTP reply is where
    // the reason lives.
    expect(screen.getByText(PROVIDER_ERROR)).toBeInTheDocument();
  });

  it("expands through a link, so the open row survives a reload and a share", async () => {
    await renderList();

    const triggers = screen.getAllByRole("link", { name: "ui.expandRow" });
    expect(triggers).toHaveLength(EVENTS.length);
    expect(triggers.some((link) => link.getAttribute("href")?.includes(`expand=${FAILED_ID}`))).toBe(
      true,
    );
  });

  it("names the open row's control as a collapse and clears the parameter", async () => {
    await renderList({ expand: FAILED_ID });

    const collapse = screen.getByRole("link", { name: "ui.collapseRow" });
    expect(collapse.getAttribute("href")).not.toContain("expand=");
  });

  it("gives the expansion no controls at all — no resend, no preview", async () => {
    await renderList({ expand: FAILED_ID });

    const panel = screen.getByText(PROVIDER_ERROR).closest("tr");
    if (panel === null) {
      throw new Error("the expansion must render as a sibling table row");
    }

    /*
     * Structural, and deliberately not a search for "Reenviar": the drawn
     * resend, resend-to-another-address and body preview are all absent, and
     * the guard has to keep holding when somebody rewords a button. A read-only
     * panel cannot mail anything to anyone.
     *
     * Resend to the ORIGINAL recipient stays defensible — but `POST
     * /admin/emails/:id/retry` requires the caller to supply the template
     * payload, which is the one object this dashboard must never hold.
     */
    expect(within(panel).queryAllByRole("button")).toHaveLength(0);
    expect(within(panel).queryAllByRole("link")).toHaveLength(0);
    expect(within(panel).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("degrades an unrecognised ?status= to no filter", async () => {
    await renderList({ status: "NOT_A_STATUS" });

    // Not a 400 the operator cannot read, and not a silent empty list either.
    expect(requestedParams()).not.toHaveProperty("status");
  });

  it("fetches with the TOP of the cursor stack, not the first entry", async () => {
    await renderList({ cursor: ["page-two", "page-three"] });

    // `cursor` is a repeated param holding the whole path back to page one.
    // Reading `[0]` re-fetches page two forever while the operator presses next.
    expect(requestedParams()).toMatchObject({ cursor: "page-three" });
  });

  it("narrows ?limit= to an offered page size", async () => {
    await renderList({ limit: "37" });

    // A clamped 37 would leave the page-size control with nothing selected and
    // make the paginator's "showing 38–74" arithmetic wrong.
    expect(requestedParams()).toMatchObject({ limit: 50 });
  });

  it("shows the empty state rather than an empty frame", async () => {
    listEmailEvents.mockResolvedValue(pageOf([]));

    await renderList();

    expect(screen.getByText("admin.emails.emptyTitle")).toBeInTheDocument();
    // The column headings stay on screen: a reader can still see what it is
    // they have none of.
    expect(screen.getByText("admin.emails.columns.recipient")).toBeInTheDocument();
  });

  it("fails with the admin error state and never with the API's own words", async () => {
    listEmailEvents.mockRejectedValue(
      new AdminApiError({ code: "INTERNAL_ERROR", status: 500, message: "server-authored english" }),
    );

    await renderList();

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/server-authored english/)).toBeNull();
  });
});
