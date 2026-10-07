import { getTranslations } from "next-intl/server";
import {
  STORE_LOCALE,
  STORE_TIME_ZONE,
  jobStateSchema,
  type Job,
  type JobState,
} from "@akai/contracts";
import { createServerApiClient } from "@/lib/api/client";
import { createAdminHttp } from "@/lib/admin/http-adapter";
import { getJobsSummary, listJobs } from "@/lib/admin/api";
import { topicNeedsAttention } from "@/lib/admin/job-display";
import { AdminErrorState } from "@/components/admin/admin-error-state";
import { PageTemplate } from "@/components/shell/page-template";
import { FilterBar, single, type FilterField } from "@/components/ui/filter-bar";
import { Notice } from "@/components/ui/notice";
import { CursorPagination, PAGE_SIZES, activeCursor } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type Column, type TableExpansion } from "@/components/ui/table";

/**
 * Background jobs — the transactional outbox.
 *
 * Producers commit a row in the same transaction as the change it describes, and
 * a dispatcher drains them. Until this page existed, a stuck revalidation or an
 * undelivered order email was invisible: the producer succeeded, so everything
 * upstream looked healthy.
 *
 * NO PAYLOAD IS SHOWN, and the API does not serve one. Outbox payloads carry
 * live password-reset tokens, verification links and raw customer addresses, and
 * the only redactor available is a substring denylist over key names that the
 * email topics' own `to` field defeats (see the header of
 * `libs/contracts/src/lib/jobs.ts`). Nothing on this screen is one hop from a
 * payload either — that is why the delivery log next door has no body preview.
 *
 * THE PAGE-LEVEL NOTICE REPLACES THE PER-ROW "sin manejador" BADGE, and it is
 * the one thing here that must be exactly true. A badge repeated on every row
 * stops being read, and the artboard's blanket "no topic has a handler" is
 * false — `outbox.module.ts` registers `email` and `storefront.revalidate`. So
 * the notice NAMES the topics that are actually unrouted, one line each. On the
 * one page whose whole job is telling an operator the truth about the queue, a
 * summary that overstates the problem costs exactly as much as one that hides
 * it: both teach the reader to stop believing this screen.
 */
export const dynamic = "force-dynamic";

/** The route this list lives on. */
const PATHNAME = "/admin/jobs";

/** One of `PAGE_SIZES`, or the segmented control renders with nothing selected. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * How long a job may sit past the moment it became eligible before the QUEUE,
 * rather than the job, is the problem.
 *
 * Measured from `availableAt` and not from `createdAt`, which is the whole
 * point: a RETRYING job in backoff has been alive for an hour and is not late —
 * its next attempt is scheduled and the dispatcher is behaving. A job whose
 * eligible-at moment passed twenty minutes ago and is still sitting here means
 * nothing is draining the queue at all, which is the fact this page exists to
 * surface. The elapsed time SHOWN is still measured from `createdAt`, because
 * "how long has this message been undelivered" is the question support asks.
 */
const OVERDUE_MS = 20 * 60 * 1000;

interface AdminJobsPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminJobsPage({ searchParams }: AdminJobsPageProps) {
  const query = await searchParams;
  const t = await getTranslations("admin.jobs");
  const tUi = await getTranslations("ui");
  // The same `status.<domain>` namespace `lib/status`'s `messageKey` builds for
  // the badges below, so a filter option and the rows it returns cannot end up
  // calling one state two different things.
  const tState = await getTranslations("status.job");

  // The TOP of the cursor stack, not the first entry — see the note on
  // `activeCursor`: reading `[0]` re-fetches page two forever.
  const cursor = activeCursor(query["cursor"]);
  const limit = resolvePageSize(single(query["limit"]));
  const topic = single(query["topic"]);
  const expandedId = single(query["expand"]);
  // Parsed against the closed enum so `?state=` off the address bar degrades to
  // "no filter" rather than reaching the API as an unreadable 400.
  const parsedState = jobStateSchema.safeParse(single(query["state"]));
  const state: JobState | undefined = parsedState.success ? parsedState.data : undefined;

  const http = createAdminHttp(await createServerApiClient());

  let page: Awaited<ReturnType<typeof listJobs>>;
  let summary: Awaited<ReturnType<typeof getJobsSummary>>;
  try {
    /*
     * `Promise.all`, NOT `allSettled`, and this is the one list in the admin
     * area where that is right. Elsewhere a failed side panel should not blank
     * the figure the operator came for; here the summary IS the headline fact —
     * a table of jobs rendered without the notice above it would silently tell
     * an operator the queue is fine. Failing loudly, with the API's own words
     * on the admin error state, is the honest outcome.
     */
    [page, summary] = await Promise.all([
      listJobs(http, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(state === undefined ? {} : { state }),
        ...(topic === undefined ? {} : { topic }),
        limit,
      }),
      getJobsSummary(http),
    ]);
  } catch (cause) {
    return (
      <PageTemplate title={t("title")} width="admin">
        <AdminErrorState cause={cause} title={t("loadErrorTitle")} />
      </PageTemplate>
    );
  }

  /*
   * A topic is worth naming when it is unrouted, or when it has dead or
   * retrying rows. `unrouted` is derived on the server from the same registry
   * `summary.routedTopics` reports, so this listing and that field cannot
   * disagree — and only topics that HAVE rows appear, which is what keeps the
   * notice about a real backlog rather than about the shape of the registry.
   */
  const attention = summary.topics.filter(topicNeedsAttention);
  /*
   * `danger` for an unrouted topic or a dead row, `warning` for a purely
   * retrying backlog — the same asymmetry the badges draw, and for the same
   * reason: a retrying job may still succeed unattended, a dead one never will.
   * `Notice` binds `role="alert"` to `danger` alone, so the assertive
   * announcement is spent on the state nothing will fix by itself.
   */
  const severe = attention.some((row) => row.unrouted || row.dead > 0);

  const fields: readonly FilterField[] = [
    {
      kind: "text",
      name: "topic",
      label: t("topicLabel"),
      value: topic,
      type: "search",
      placeholder: t("topicPlaceholder"),
      // A topic is an identifier compared character by character against a
      // producer's own string, so the field it is typed into is mono too.
      mono: true,
      width: "lg",
    },
    {
      kind: "select",
      name: "state",
      label: t("stateLabel"),
      value: state,
      anyLabel: t("anyState"),
      options: jobStateSchema.options.map((value) => ({ value, label: tState(value) })),
      width: "md",
    },
  ];

  // One instant for the whole render. Reading the clock inside each cell would
  // measure rows against different "now"s and let two jobs created in the same
  // millisecond report different waits.
  const now = Date.now();

  const columns: readonly Column<Job>[] = [
    {
      key: "created",
      header: t("columns.created"),
      cell: (job) => (
        <span className="tabular-nums text-[var(--label-secondary)]">
          {formatWhen(job.createdAt)}
        </span>
      ),
    },
    {
      key: "topic",
      header: t("columns.topic"),
      // Mono, but not the table's `identifier` kind — that kind paints the cell
      // in `--accent` because identifier columns elsewhere link to the record
      // they name, and a topic links nowhere.
      cell: (job) => <span className="font-mono text-[12px]">{job.topic}</span>,
    },
    {
      key: "state",
      header: t("columns.state"),
      cell: (job, rowState) => (
        <StatusBadge
          domain="job"
          value={job.state}
          density="compact"
          onAccent={rowState.selected}
        />
      ),
    },
    {
      key: "waiting",
      header: t("columns.waiting"),
      cell: (job) => {
        const waiting = waitingFor(job, now);
        if (waiting === null) {
          return <span className="text-[var(--label-tertiary)]">—</span>;
        }
        /*
         * Colour is EMPHASIS here, never the signal: the duration itself is the
         * information and reads the same in greyscale, so the warning ink only
         * makes the row that has waited too long findable in a scan of fifty.
         */
        return (
          <span
            className={`tabular-nums${
              waiting.overdue ? " font-semibold text-[var(--warning-text)]" : ""
            }`}
          >
            {formatWaiting(waiting.ms)}
          </span>
        );
      },
    },
    {
      key: "attempts",
      header: t("columns.attempts"),
      kind: "numeric",
      cell: (job) => job.attempts,
    },
  ];

  /*
   * The handler's error text moves from a truncated cell with a `title` tooltip
   * into the expansion, exactly as it does on the delivery log next door: a
   * tooltip is invisible on a touch screen and unreachable from a keyboard, and
   * an 80-character prefix of a stack trace names the framework rather than the
   * failure. `?expand=<id>` keeps the open row in the URL, so it survives a
   * reload and this page stays a server component.
   */
  const expansion: TableExpansion<Job> = {
    expandedId,
    pathname: PATHNAME,
    searchParams: query,
    header: tUi("details"),
    label: (_job, expanded) => (expanded ? tUi("collapseRow") : tUi("expandRow")),
    render: (job) => (
      <JobDetail
        job={job}
        errorHeading={t("columns.error")}
        noErrorLabel={t("noError")}
        nextAttemptLabel={t("nextAttempt")}
        nextAttempt={isOpen(job) ? formatWhen(job.availableAt) : null}
      />
    ),
  };

  const filtered = state !== undefined || topic !== undefined;

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
      <div className="grid gap-4">
        {attention.length > 0 && (
          <Notice tone={severe ? "danger" : "warning"} title={t("attentionTitle")}>
            {/* `role="list"` is not redundant: the preflight removes the marker,
                and Safari drops the implicit role from an unstyled list. */}
            <ul role="list" className="mt-1 grid gap-0.5">
              {attention.map((row) => (
                <li key={row.topic}>
                  <span className="font-mono text-[12px]">{row.topic}</span>{" "}
                  {row.unrouted ? (
                    // The most important line on the page: no handler is
                    // registered, so every message on this topic burns its
                    // retry budget and dead-letters while its producer looks
                    // like it worked. That is a deployment defect, not a
                    // transient error, and it is invisible everywhere else.
                    <strong className="font-semibold">{t("unrouted")}</strong>
                  ) : (
                    t("backlog", { dead: row.dead, retrying: row.retrying })
                  )}
                </li>
              ))}
            </ul>
          </Notice>
        )}

        <DataTable
          caption={t("title")}
          columns={columns}
          rows={page.items}
          rowKey={(job) => job.id}
          expansion={expansion}
          minWidth="narrow"
          empty={
            <EmptyState
              density="table"
              icon="list-checks"
              reason={filtered ? "no-matches" : "nothing-yet"}
              title={t("emptyTitle")}
              body={t("emptyBody")}
            />
          }
          // Kept even on an empty page: an operator who lands on an empty page
          // four — a stale link, or a filter applied to a deep cursor — needs
          // the way back, and that is the one moment the control is the only
          // way out.
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
      </div>
    </PageTemplate>
  );
}

interface JobDetailProps {
  readonly job: Job;
  /** Already translated, all three — this panel never reaches a namespace. */
  readonly errorHeading: string;
  readonly noErrorLabel: string;
  readonly nextAttemptLabel: string;
  /** Already formatted, or `null` for a job that will not be attempted again. */
  readonly nextAttempt: string | null;
}

/**
 * What one row expands to. NO PAYLOAD, here or anywhere on this screen.
 *
 * Every row opens, not only the failed ones: a chevron present on some rows and
 * absent on others reads as a second status column, and a reader cannot tell
 * "nothing to see" from "not loaded".
 */
function JobDetail({
  job,
  errorHeading,
  noErrorLabel,
  nextAttemptLabel,
  nextAttempt,
}: JobDetailProps) {
  return (
    <div className="grid gap-1.5 pt-0.5">
      {job.lastError === null ? (
        <p className="text-[var(--label-secondary)]">{noErrorLabel}</p>
      ) : (
        <>
          <p className="text-[11px] font-semibold text-[var(--label-secondary)]">{errorHeading}</p>
          {/* The handler's own words, WHOLE. It is written for whoever is on
              call and it is the only thing that explains why a job is stuck —
              an operator screen is the one audience the platform's "never
              render a server-authored message" rule exempts. */}
          <pre className="m-0 max-w-full rounded-[var(--r-check)] bg-[var(--bg-grouped-secondary)] px-2.5 py-2 font-mono text-[11px] leading-[1.5] break-words whitespace-pre-wrap text-[var(--neutral-text)]">
            {job.lastError}
          </pre>
        </>
      )}
      {nextAttempt === null ? null : (
        /* Why a row that has waited an hour is not necessarily late: backoff
           schedules the next attempt, and this is when it is due. */
        <p className="text-[12px] text-[var(--label-secondary)]">
          {nextAttemptLabel}{" "}
          <span className="tabular-nums text-[var(--label)]">{nextAttempt}</span>
        </p>
      )}
    </div>
  );
}

interface Waiting {
  /** Elapsed since the row was written, in milliseconds. */
  readonly ms: number;
  readonly overdue: boolean;
}

/** A job the dispatcher may still pick up. PROCESSED and DEAD are terminal. */
function isOpen(job: Job): boolean {
  return job.state === "PENDING" || job.state === "RETRYING";
}

/**
 * How long this job has been waiting, or `null` if it is not waiting for
 * anything.
 *
 * A PROCESSED job is done and a DEAD one gave up, so both get an em dash rather
 * than a number. Showing "3 d" against either would answer a question the
 * column heading is not asking — an elapsed time under "Esperando" reads as
 * "still queued", which for a dead row is the opposite of the truth.
 */
function waitingFor(job: Job, now: number): Waiting | null {
  if (!isOpen(job)) {
    return null;
  }

  const created = Date.parse(job.createdAt);
  const available = Date.parse(job.availableAt);
  if (Number.isNaN(created) || Number.isNaN(available)) {
    // Unreachable through `jobSchema`, which validates both as ISO date-times.
    // Rendering "NaN min" to an operator is worse than rendering nothing.
    return null;
  }

  // Clamped at zero: a row written by a database whose clock is a second ahead
  // of this process must not report a negative wait.
  return { ms: Math.max(0, now - created), overdue: available <= now - OVERDUE_MS };
}

/**
 * "24 min", "3 h", "2 d" — through `Intl`, so the number, the unit and the
 * space between them are es-CO's rather than ours, and no message key is
 * needed for a string that is entirely data.
 */
function formatWaiting(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return formatUnit(minutes, "minute");
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return formatUnit(hours, "hour");
  }
  return formatUnit(Math.floor(hours / 24), "day");
}

function formatUnit(value: number, unit: "minute" | "hour" | "day"): string {
  return new Intl.NumberFormat(STORE_LOCALE, {
    style: "unit",
    unit,
    unitDisplay: "short",
  }).format(value);
}

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat(STORE_LOCALE, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: STORE_TIME_ZONE,
  }).format(new Date(iso));
}

/**
 * `?limit=` is user input off the address bar, NARROWED to the three sizes the
 * control offers rather than clamped to the contract's 1..100 — a clamped 37
 * would leave the segmented control with nothing selected and no way back to a
 * known size, and would make the paginator's range arithmetic wrong.
 */
function resolvePageSize(raw: string | undefined): number {
  const parsed = Number(raw);
  return PAGE_SIZES.includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}
