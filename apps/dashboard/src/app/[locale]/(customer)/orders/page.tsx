import { getLocale, getTranslations } from "next-intl/server";

import { AccountErrorPanel } from "@/components/account/account-error-panel";
import { asLocale } from "@/components/account/format";
import { OrderList } from "@/components/account/order-list";
import { PageTemplate } from "@/components/shell/page-template";
import {
  CursorPagination,
  PAGE_SIZES,
  activeCursor,
  cursorStack,
  type PaginationLabels,
} from "@/components/ui/pagination";
import type { SearchParamValue } from "@/components/ui/segmented-control";
import { createAccountApi } from "@/lib/account";
import { createServerApiClient } from "@/lib/api/client";

export const dynamic = "force-dynamic";

/** The route the cursor links are built against. `Link` adds the locale. */
const ORDERS_PATHNAME = "/orders";

/**
 * The default page size is 25, NOT `paginationQuerySchema`'s own default of 24.
 *
 * The per-page control offers 25/50/100 — the three sizes `ui/pagination` fixes
 * because the contract clamps `limit` at 100 — and it marks the segment matching
 * the limit in force. Letting the API default apply would render that control
 * with no segment selected on every first visit, which reads as a broken filter.
 * So the limit is always explicit and always one of the three.
 */
const DEFAULT_PAGE_SIZE = 25;

/**
 * Reads `limit` out of the URL, falling back rather than failing.
 *
 * A hand-edited or stale `?limit=7` is not an error worth a 400 in front of a
 * customer looking at their own orders, and `paginationQuerySchema` would reject
 * anything outside 1..100 anyway. An unrecognised value silently becomes the
 * default — the list is still correct, only the page size is not what was asked.
 */
function readPageSize(value: SearchParamValue): number {
  const raw = typeof value === "string" ? value : value?.at(-1);
  if (raw === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  const parsed = Number.parseInt(raw, 10);
  return PAGE_SIZES.includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

interface OrdersPageProps {
  /** Next 15 hands query params as a promise. */
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Purchase history, one cursor page at a time.
 *
 * THE WHOLE PAGE IS SERVER-RENDERED, and the cursor lives in the URL rather
 * than in React state. What that buys, over the load-more list it replaces: a
 * working "previous", a reloadable and shareable position in the history, and
 * no client bundle for a screen that is a table of text.
 *
 * THERE IS NO SEARCH FIELD AND NO STATUS FILTER, though the artboard draws
 * both. `customerOrderListQuerySchema` (apps/api/src/modules/orders/dto) is
 * `paginationQuerySchema` — cursor and limit, nothing else. A control here
 * could only re-filter the twenty-five rows already fetched while claiming to
 * filter the history, which is the same lie the plan rejected column sorting
 * for. `limit` is the opposite case and IS built: it is a real, plumbed
 * parameter, so the per-page control inside `CursorPagination` is honest.
 */
export default async function OrdersPage({ searchParams }: OrdersPageProps) {
  const query = await searchParams;
  const t = await getTranslations("account.orders");
  const tUi = await getTranslations("ui");
  const locale = asLocale(await getLocale());

  // The TOP of the stack, not its first entry: the repeated `cursor` param is
  // the history of how the reader got here, and the last one is where they are.
  const cursor = activeCursor(query["cursor"]);
  const depth = cursorStack(query["cursor"]).length;
  const limit = readPageSize(query["limit"]);

  const account = createAccountApi(await createServerApiClient());
  // `exactOptionalPropertyTypes`: `cursor: undefined` is not the same as an
  // absent cursor, and `orderListPath` drops undefined values for the same
  // reason — `?cursor=undefined` is a present-but-nonsense cursor to the API.
  const result = await account.listOrders({
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  });

  if (!result.ok) {
    return <AccountErrorPanel title={t("title")} error={result.error} />;
  }

  const page = result.data;

  const labels: PaginationLabels = {
    nav: tUi("pagination"),
    first: tUi("first"),
    // Order-specific rather than the generic "Anterior"/"Siguiente": in a list
    // sorted newest-first, "previous" and "next" are ambiguous about which
    // direction is older. "Pedidos anteriores" / "Pedidos más antiguos" is not.
    previous: t("previousPage"),
    next: t("nextPage"),
    page: (pageNumber) => tUi("page", { page: pageNumber }),
    perPage: tUi("perPage"),
    // `from`/`to` are deliberately unused. The generic `ui.showing` summary
    // ("Mostrando 51–75") reads as a position in a total the API never counts;
    // the account catalogue carries a count-plus-"there are older ones" phrasing
    // that says only what cursor pagination actually knows.
    showing: ({ hasMore }) =>
      hasMore
        ? t("showingMore", { count: page.items.length })
        : t("showing", { count: page.items.length }),
  };

  // Suppressed on a first page with nothing on it: a customer who has never
  // ordered is shown the empty state, not two inert chevrons and a page-size
  // control for a list that does not exist. Kept at depth > 0, where an empty
  // page is reachable and "previous" is the only way back.
  const showPagination = page.items.length > 0 || depth > 0;

  return (
    <PageTemplate title={t("title")} description={t("subtitle")} width="table">
      <OrderList
        orders={page.items}
        locale={locale}
        {...(showPagination
          ? {
              footer: (
                <CursorPagination
                  labels={labels}
                  pathname={ORDERS_PATHNAME}
                  searchParams={query}
                  itemCount={page.items.length}
                  pageSize={limit}
                  hasMore={page.hasMore}
                  nextCursor={page.nextCursor}
                />
              ),
            }
          : {})}
      />
    </PageTemplate>
  );
}
