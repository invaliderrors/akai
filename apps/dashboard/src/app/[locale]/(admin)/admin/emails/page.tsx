import { getTranslations } from "next-intl/server";
import { emailStatusSchema, type EmailEvent, type EmailStatus, type Locale } from "@akai/contracts";
import { createServerApiClient } from "@/lib/api/client";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { listEmailEvents } from "@/lib/admin/api";
import { isPending } from "@/lib/admin/email-display";
import { asLocale } from "@/lib/admin/inventory-display";
import { AdminErrorState } from "@/components/admin/admin-error-state";
import { PageTemplate } from "@/components/shell/page-template";
import { FilterBar, single, type FilterField } from "@/components/ui/filter-bar";
import { CursorPagination, PAGE_SIZES, activeCursor } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type Column, type TableExpansion } from "@/components/ui/table";

/**
 * The delivery log.
 *
 * One row per send, with the provider-side outcome. This is the first question
 * support ever asks — "did the confirmation actually go out?" — and until this
 * page existed the only way to answer it was to read the API's logs.
 *
 * Filters live in the URL so a view is linkable, and pagination is cursor-based
 * because rows are written continuously: under OFFSET a mail sent between two
 * page loads makes a row appear twice or vanish. Both of those are also what
 * keep this a SERVER component — the filter bar is a GET form and the paginator
 * is a row of links, so nothing here hydrates.
 *
 * TWO THINGS THE ARTBOARD DREW ARE DELIBERATELY ABSENT, and they are the same
 * decision twice:
 *
 *   - The rendered body preview. `verify-email` and `reset-password` bodies
 *     carry live single-use tokens; re-rendering one on a screen every STAFF
 *     user can open turns a diagnostics page into an account-takeover surface.
 *     It is the argument that keeps outbox payloads off /admin/jobs, applied to
 *     the same data one hop later.
 *   - "Reenviar a otra dirección…", and resend in general. Mailing a template
 *     to an operator-chosen address is the preview leak with a delivery
 *     mechanism attached. Resend to the ORIGINAL recipient would be defensible,
 *     but it is not callable from here: `POST /admin/emails/:id/retry` requires
 *     the caller to supply `payload` (email-admin.dto.ts:54-58), which is
 *     precisely the object this dashboard must never hold. A resend button
 *     needs a payload-free endpoint first. `canRetry` in `lib/admin/email-
 *     display.ts` already states the API's 409 rule for the day it lands.
 */
export const dynamic = "force-dynamic";

/** The route this list lives on. `Link` adds the locale prefix. */
const PATHNAME = "/admin/emails";

/** One of `PAGE_SIZES`, or the segmented control renders with nothing selected. */
const DEFAULT_PAGE_SIZE = 50;

interface AdminEmailsPageProps {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminEmailsPage({ params, searchParams }: AdminEmailsPageProps) {
  const { locale: rawLocale } = await params;
  const query = await searchParams;
  const locale = asLocale(rawLocale);
  const t = await getTranslations("admin.emails");
  const tUi = await getTranslations("ui");
  /*
   * The SAME namespace `lib/status`'s `messageKey` builds for the badges in the
   * rows below. Reading the filter's option labels from `status.email` rather
   * than from this page's own `statuses` block is what stops the two saying
   * different things about one value — an operator filtering by "Rebotado" and
   * getting rows labelled something else has to guess which one is the truth.
   */
  const tStatus = await getTranslations("status.email");

  // The TOP of the cursor stack, not the first entry: `cursor` is a repeated
  // param carrying the whole path back to page one, and reading `[0]` would
  // re-fetch page two forever while the operator pressed next.
  const cursor = activeCursor(query["cursor"]);
  const limit = resolvePageSize(single(query["limit"]));
  const recipient = single(query["recipient"]);
  const expandedId = single(query["expand"]);
  // Parsed against the closed enum: `?status=` is user input off the address
  // bar, and an unrecognised value must degrade to "no filter" rather than
  // reaching the API as a validation failure the operator cannot read.
  const parsedStatus = emailStatusSchema.safeParse(single(query["status"]));
  const status: EmailStatus | undefined = parsedStatus.success ? parsedStatus.data : undefined;

  const http = createAdminHttp(await createServerApiClient());

  let page: Awaited<ReturnType<typeof listEmailEvents>>;
  try {
    page = await listEmailEvents(http, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(status === undefined ? {} : { status }),
      ...(recipient === undefined ? {} : { recipient }),
      limit,
    });
  } catch (cause) {
    return (
      <PageTemplate title={t("title")} width="admin">
        <AdminErrorState cause={cause} title={t("loadErrorTitle")} />
      </PageTemplate>
    );
  }

  const fields: readonly FilterField[] = [
    {
      kind: "text",
      name: "recipient",
      label: t("recipientLabel"),
      value: recipient,
      type: "search",
      placeholder: t("recipientPlaceholder"),
      width: "lg",
    },
    {
      kind: "select",
      name: "status",
      label: t("statusLabel"),
      value: status,
      anyLabel: t("anyStatus"),
      options: emailStatusSchema.options.map((value) => ({ value, label: tStatus(value) })),
      width: "md",
    },
  ];

  const columns: readonly Column<EmailEvent>[] = [
    {
      key: "sentAt",
      header: t("columns.sentAt"),
      cell: (event) => (
        <span className="tabular-nums text-[var(--label-secondary)]">
          {formatWhen(event, locale)}
        </span>
      ),
    },
    {
      key: "recipient",
      header: t("columns.recipient"),
      cell: (event) => event.recipient,
    },
    {
      key: "template",
      header: t("columns.template"),
      /*
       * Mono, but NOT the table's `identifier` kind. That kind paints its cell
       * in `--accent`, because every other identifier column in the product is
       * a link to the record it names (see the note in `ui/table.tsx`). A
       * template key links nowhere, and blue text that does nothing when
       * clicked is a worse lie than a missing colour.
       */
      cell: (event) => <span className="font-mono text-[12px]">{event.templateKey}</span>,
    },
    {
      key: "status",
      header: t("columns.status"),
      cell: (event, state) => (
        <StatusBadge
          domain="email"
          value={event.status}
          density="compact"
          onAccent={state.selected}
        />
      ),
    },
    {
      key: "attempts",
      header: t("columns.attempts"),
      kind: "numeric",
      cell: (event) => event.attempts,
    },
  ];

  /*
   * THE ERROR COLUMN IS GONE, and the provider's own words are in the expansion
   * instead. They used to be truncated to 80 characters with the full string in
   * a `title` attribute — which is invisible on a touch screen, invisible to a
   * keyboard, and unreadable to a screen reader that is not in browse mode. The
   * expansion is a link, so it works everywhere, and the string arrives whole.
   *
   * The open row is `?expand=<id>`, never client state: in the URL it survives a
   * reload and a share, and the list stays on the server.
   */
  const expansion: TableExpansion<EmailEvent> = {
    expandedId,
    pathname: PATHNAME,
    searchParams: query,
    header: tUi("details"),
    label: (_event, expanded) => (expanded ? tUi("collapseRow") : tUi("expandRow")),
    render: (event) => (
      <EmailDetail
        event={event}
        errorHeading={t("columns.error")}
        noErrorLabel={t("noError")}
        awaitingLabel={t("awaitingProvider")}
        providerLabel={t("providerMessageId")}
      />
    ),
  };

  const filtered = status !== undefined || recipient !== undefined;

  return (
    <PageTemplate
      title={t("title")}
      description={t("description")}
      width="admin"
      filters={
        <FilterBar
          label={tUi("filters")}
          fields={fields}
          pathname={PATHNAME}
          searchParams={query}
          labels={{
            apply: tUi("apply"),
            clear: tUi("clear"),
            active: tUi("activeFilters"),
            remove: (filter) => tUi("removeFilter", { name: filter }),
          }}
        />
      }
    >
      <DataTable
        caption={t("title")}
        columns={columns}
        rows={page.items}
        rowKey={(event) => event.id}
        expansion={expansion}
        minWidth="narrow"
        empty={
          <EmptyState
            density="table"
            icon="mail"
            reason={filtered ? "no-matches" : "nothing-yet"}
            title={t("emptyTitle")}
            body={t("emptyBody")}
          />
        }
        /*
         * Rendered even when the page is empty. An operator who lands on an
         * empty page four — a stale link, a filter applied to a deep cursor —
         * needs the way back, and removing the control exactly when it is the
         * only way out is how the superseded one-way "Next page" link stranded
         * people.
         */
        footer={
          <CursorPagination
            labels={{
              nav: tUi("pagination"),
              first: tUi("first"),
              previous: tUi("previous"),
              next: tUi("next"),
              page: (value) => tUi("page", { page: value }),
              perPage: tUi("perPage"),
              showing: ({ from, to, hasMore }) =>
                hasMore ? tUi("showingMore", { from, to }) : tUi("showing", { from, to }),
            }}
            pathname={PATHNAME}
            searchParams={query}
            itemCount={page.items.length}
            pageSize={limit}
            hasMore={page.hasMore}
            nextCursor={page.nextCursor}
          />
        }
      />
    </PageTemplate>
  );
}

interface EmailDetailProps {
  readonly event: EmailEvent;
  /** Already translated, all four — this panel never reaches a namespace. */
  readonly errorHeading: string;
  readonly noErrorLabel: string;
  readonly awaitingLabel: string;
  readonly providerLabel: string;
}

/**
 * What one row expands to.
 *
 * EVERY ROW OPENS, not only the failed ones, because the disclosure column is a
 * column: a chevron that is present on some rows and absent on others reads as
 * a second status, and a reader cannot tell "nothing to see" from "not loaded".
 * So a row with no error says which of the two silences it is — a send still in
 * flight at the provider, or one that simply never errored.
 */
function EmailDetail({
  event,
  errorHeading,
  noErrorLabel,
  awaitingLabel,
  providerLabel,
}: EmailDetailProps) {
  return (
    <div className="grid gap-1.5 pt-0.5">
      {event.error === null ? (
        <p className="text-[var(--label-secondary)]">
          {/* SENT means the provider accepted it and nothing has come back yet.
              Saying so is the difference between "in flight" and "the bounce
              webhook is not wired up", which look identical in the table. */}
          {isPending(event.status) ? awaitingLabel : noErrorLabel}
        </p>
      ) : (
        <>
          <p className="text-[11px] font-semibold text-[var(--label-secondary)]">{errorHeading}</p>
          {/* The provider's own failure text, WHOLE and unedited. It is written
              for whoever is on call, it is the only thing that explains a
              bounce, and this is an operator screen — the one audience the
              platform's "never render a server-authored message" rule exempts.
              `whitespace-pre-wrap` keeps an SMTP reply's own line breaks; the
              column allows 1000 characters, so it also has to wrap. */}
          <pre className="m-0 max-w-full rounded-[var(--r-check)] bg-[var(--bg-grouped-secondary)] px-2.5 py-2 font-mono text-[11px] leading-[1.5] break-words whitespace-pre-wrap text-[var(--neutral-text)]">
            {event.error}
          </pre>
        </>
      )}
      {event.providerMessageId === null ? null : (
        /* The correlation key for a support ticket — an opaque provider id, not
           payload. It is what turns "we think we sent it" into a line the
           provider's own dashboard can be searched for. */
        <p className="text-[12px] text-[var(--label-secondary)]">
          {providerLabel}{" "}
          <span className="font-mono text-[11px] text-[var(--label)]">
            {event.providerMessageId}
          </span>
        </p>
      )}
    </div>
  );
}

/** Sent time when there is one, otherwise when the row was created. */
function formatWhen(event: EmailEvent, locale: Locale): string {
  const iso = event.sentAt ?? event.createdAt;
  return new Intl.DateTimeFormat(locale === "es" ? "es-CO" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

/**
 * `?limit=` is user input off the address bar, and it is NARROWED to the three
 * sizes the control offers rather than clamped to the contract's 1..100.
 *
 * A clamped 37 would fetch 37 rows with no segment selected, so the operator
 * would have no way back to a known size and the paginator's "showing 38–74"
 * arithmetic — which assumes every page below this one was exactly `pageSize`
 * long — would quietly be wrong.
 */
function resolvePageSize(raw: string | undefined): number {
  const parsed = Number(raw);
  return PAGE_SIZES.includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}
