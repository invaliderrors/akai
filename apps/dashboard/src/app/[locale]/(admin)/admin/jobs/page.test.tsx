import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jobSchema, jobsSummarySchema, type Job, type JobsSummary } from "@akai/contracts";

import { AdminApiError } from "@/lib/admin/http";

import esMessages from "../../../../../../messages/es.json";

/**
 * The outbox.
 *
 * WHAT IS ACTUALLY UNDER TEST — this is the one page whose entire job is telling
 * an operator the truth about the queue, so every assertion here is about
 * whether a statement on it is TRUE:
 *
 *  1. THE NOTICE NAMES THE UNROUTED TOPICS. The artboard drew a blanket "no
 *     topic has a handler", which is false: `outbox.module.ts` registers `email`
 *     and `storefront.revalidate`. A summary that overstates the problem costs
 *     what one that hides it costs — the reader stops believing the screen.
 *  2. IT SAYS IT ONCE. The per-row "sin manejador" badge is gone; a badge on
 *     every row stops carrying information.
 *  3. WAITING IS MEASURED AGAINST `availableAt`, NOT AGE. A retrying job in
 *     backoff has been alive for ninety minutes and is not late — its next
 *     attempt is scheduled. Warning ink on that row would train an operator to
 *     ignore the colour on the row that IS stuck.
 *  4. NO PAYLOAD, ever, and the handler's error is in the expansion rather than
 *     in a `title` tooltip no touch or keyboard user can reach.
 *
 * The server translator returns the KEY PATH it was asked for, so an assertion
 * names the catalogue entry rather than the Spanish behind it. The client half
 * runs against the real `es.json`, because the state badges are exactly where a
 * raw enum would leak.
 */

const listJobs = vi.fn<(http: unknown, params: unknown) => Promise<unknown>>();
const getJobsSummary = vi.fn<(http: unknown) => Promise<unknown>>();

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock("@/lib/api/client", () => ({ createServerApiClient: async () => ({}) }));
vi.mock("@/lib/admin/http-adapter", () => ({ createAdminHttp: () => ({}) }));
vi.mock("@/lib/admin/api", () => ({
  listJobs: (http: unknown, params: unknown) => listJobs(http, params),
  getJobsSummary: (http: unknown) => getJobsSummary(http),
}));

const { default: AdminJobsPage } = await import("./page");

const NOW = Date.now();
const RETRYING_ID = "22222222-2222-4222-8222-222222222222";

function minutesFromNow(minutes: number): string {
  return new Date(NOW + minutes * 60_000).toISOString();
}

const HANDLER_ERROR =
  "Error: connect ECONNREFUSED 127.0.0.1:2525\n    at TCPConnectWrap.afterConnect [as oncomplete]";

/**
 * Parsed through the contract, not cast to it. The topic names are the REAL
 * ones — `invoice-pdf`, `email`, `storefront.revalidate` — where the artboard
 * drew "invoice.render" and "email.send", neither of which any producer emits.
 */
const JOBS: readonly Job[] = [
  jobSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    topic: "invoice-pdf",
    state: "PENDING",
    attempts: 0,
    lastError: null,
    availableAt: minutesFromNow(-24),
    processedAt: null,
    deadAt: null,
    createdAt: minutesFromNow(-24),
    unrouted: true,
  }),
  jobSchema.parse({
    id: RETRYING_ID,
    topic: "email",
    state: "RETRYING",
    attempts: 2,
    lastError: HANDLER_ERROR,
    // In BACKOFF: eligible ten minutes from now, so ninety minutes old and not
    // late. This row is the whole reason the overdue rule reads `availableAt`.
    availableAt: minutesFromNow(10),
    processedAt: null,
    deadAt: null,
    createdAt: minutesFromNow(-90),
    unrouted: false,
  }),
  jobSchema.parse({
    id: "33333333-3333-4333-8333-333333333333",
    topic: "storefront.revalidate",
    state: "PROCESSED",
    attempts: 1,
    lastError: null,
    availableAt: minutesFromNow(-120),
    processedAt: minutesFromNow(-119),
    deadAt: null,
    createdAt: minutesFromNow(-120),
    unrouted: false,
  }),
];

const SUMMARY: JobsSummary = jobsSummarySchema.parse({
  topics: [
    {
      topic: "invoice-pdf",
      pending: 3,
      retrying: 0,
      dead: 0,
      processed: 0,
      unrouted: true,
      oldestPendingAt: minutesFromNow(-24),
    },
    {
      topic: "email",
      pending: 0,
      retrying: 2,
      dead: 1,
      processed: 40,
      unrouted: false,
      oldestPendingAt: null,
    },
    // Routed, drained, nothing wrong: it must NOT appear in the notice.
    {
      topic: "storefront.revalidate",
      pending: 0,
      retrying: 0,
      dead: 0,
      processed: 812,
      unrouted: false,
      oldestPendingAt: null,
    },
  ],
  routedTopics: ["email", "storefront.revalidate"],
});

function pageOf(items: readonly Job[]) {
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
  const element = await AdminJobsPage({
    params: Promise.resolve({ locale: "es" }),
    searchParams: Promise.resolve(query),
  });
  return renderPage(element);
}

function requestedParams(): unknown {
  const call = listJobs.mock.calls[0];
  if (call === undefined) {
    throw new Error("the page did not call listJobs");
  }
  return call[1];
}

describe("AdminJobsPage", () => {
  beforeEach(() => {
    listJobs.mockReset();
    getJobsSummary.mockReset();
    listJobs.mockResolvedValue(pageOf(JOBS));
    getJobsSummary.mockResolvedValue(SUMMARY);
  });

  it("names the unrouted topic instead of claiming no topic has a handler", async () => {
    await renderList();

    const notice = screen.getByRole("alert");
    expect(within(notice).getByText("invoice-pdf")).toBeInTheDocument();
    expect(within(notice).getByText("admin.jobs.unrouted")).toBeInTheDocument();
    // The registered consumers are not accused: `email` appears for its
    // backlog, and a topic that is routed and drained is absent entirely.
    expect(within(notice).getByText("admin.jobs.backlog")).toBeInTheDocument();
    expect(within(notice).queryByText("storefront.revalidate")).toBeNull();
  });

  it("says it once — there is no per-row handler badge", async () => {
    await renderList();

    expect(screen.queryAllByText("admin.jobs.noHandler")).toHaveLength(0);
    // Once for the one unrouted topic, and nowhere in the fifty rows below it.
    expect(screen.getAllByText("admin.jobs.unrouted")).toHaveLength(1);
  });

  it("drops the notice when every topic is routed and drained", async () => {
    getJobsSummary.mockResolvedValue(
      jobsSummarySchema.parse({
        topics: [
          {
            topic: "email",
            pending: 0,
            retrying: 0,
            dead: 0,
            processed: 40,
            unrouted: false,
            oldestPendingAt: null,
          },
        ],
        routedTopics: ["email", "storefront.revalidate"],
      }),
    );

    await renderList();

    // A permanent banner is a banner nobody reads.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("marks a job the dispatcher should already have taken", async () => {
    await renderList();

    expect(screen.getByText("24 min")).toHaveClass("text-[var(--warning-text)]");
  });

  it("leaves a job in backoff unmarked, however old it is", async () => {
    await renderList();

    // Ninety minutes old, next attempt ten minutes out. Nothing is wrong.
    expect(screen.getByText("1 h")).not.toHaveClass("text-[var(--warning-text)]");
  });

  it("shows no waiting time for a job that is no longer waiting", async () => {
    await renderList();

    // "3 d" under "Esperando" against a PROCESSED row would read as still
    // queued, which is the opposite of the truth.
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("labels every state through the shared vocabulary, never as the raw enum", async () => {
    await renderList();

    expect(screen.getByText("Pendiente")).toBeInTheDocument();
    expect(screen.getByText("Reintentando")).toBeInTheDocument();
    expect(screen.queryByText("RETRYING")).toBeNull();
  });

  it("offers the state filter the same labels the badges use", async () => {
    await renderList();

    const select = screen.getByLabelText("admin.jobs.stateLabel");
    expect(within(select).getByRole("option", { name: "status.job.DEAD" })).toBeInTheDocument();
  });

  it("keeps the handler error out of the table and out of a tooltip", async () => {
    await renderList();

    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull();
    expect(screen.queryByTitle(/ECONNREFUSED/)).toBeNull();
  });

  it("reveals the whole handler error when the row is expanded through the URL", async () => {
    await renderList({ expand: RETRYING_ID });

    // Matched loosely, then compared exactly: `getByText` collapses whitespace,
    // and a stack trace's own indentation is part of what makes it readable.
    const reply = screen.getByText(/ECONNREFUSED/);
    expect(reply.textContent).toBe(HANDLER_ERROR);

    const panel = reply.closest("tr");
    if (panel === null) {
      throw new Error("the expansion must render as a sibling table row");
    }

    // Read-only, like the delivery log's: nothing on this screen may act on a
    // job, and nothing on it may show a payload.
    expect(within(panel).queryAllByRole("button")).toHaveLength(0);
    expect(within(panel).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("degrades an unrecognised ?state= to no filter", async () => {
    await renderList({ state: "NOT_A_STATE" });

    expect(requestedParams()).not.toHaveProperty("state");
  });

  it("fetches with the TOP of the cursor stack, not the first entry", async () => {
    await renderList({ cursor: ["page-two", "page-three"] });

    expect(requestedParams()).toMatchObject({ cursor: "page-three" });
  });

  it("fails loudly when the summary cannot be loaded", async () => {
    getJobsSummary.mockRejectedValue(
      new AdminApiError({ code: "INTERNAL_ERROR", status: 500, message: "server-authored english" }),
    );

    await renderList();

    /*
     * The whole page fails rather than rendering the table alone. The summary
     * is not a side panel here: a list of jobs with no notice above it tells an
     * operator the queue is healthy, which is a claim nothing has checked.
     */
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("invoice-pdf")).toBeNull();
    expect(screen.queryByText(/server-authored english/)).toBeNull();
  });
});
