import {
  type BulkLabelResult,
  type CancelLabelResult,
  PRINT_LABELS_COUNT_HEADER,
  PRINT_LABELS_SKIPPED_HEADER,
  bulkLabelRequestSchema,
  bulkLabelResultSchema,
  cancelLabelResultSchema,
  idSchema,
  printLabelsRequestSchema,
} from "@akai/contracts";
import { z } from "zod";

import { buildUrl } from "../api/http";
import { AdminApiError, parseOrThrow, toApiError, type AdminHttp } from "./http";

/**
 * The staff label endpoints (Sendcloud spec §5) — `/v1/admin/fulfilment/*`.
 *
 * Its own module rather than more of `api.ts`, because two of the five calls
 * do not speak JSON: the print answers `application/pdf` and the download
 * answers a 302. Those go through `AdminRawHttp` — a bare authenticated
 * `fetch` — while the JSON three use the ordinary `AdminHttp` port and its
 * brand-preserving parse.
 */

/** POST generate. The key is the CALLER's: one click = one key across retries. */
export async function generateLabels(
  http: AdminHttp,
  orderIds: readonly string[],
  idempotencyKey: string,
): Promise<BulkLabelResult> {
  const response = await http.request({
    method: "POST",
    path: "/admin/fulfilment/labels",
    body: { orderIds },
    idempotencyKey,
  });
  return parseOrThrow(bulkLabelResultSchema, response);
}

export async function cancelLabel(
  http: AdminHttp,
  shipmentId: string,
  idempotencyKey: string,
): Promise<CancelLabelResult> {
  const response = await http.request({
    method: "POST",
    path: `/admin/fulfilment/shipments/${shipmentId}/cancel`,
    idempotencyKey,
  });
  return parseOrThrow(cancelLabelResultSchema, response);
}

export async function retryLabel(
  http: AdminHttp,
  shipmentId: string,
  idempotencyKey: string,
): Promise<BulkLabelResult> {
  const response = await http.request({
    method: "POST",
    path: `/admin/fulfilment/shipments/${shipmentId}/retry`,
    idempotencyKey,
  });
  return parseOrThrow(bulkLabelResultSchema, response);
}

// ---------------------------------------------------------------------------
// Non-JSON calls
// ---------------------------------------------------------------------------

export interface AdminRawRequest {
  readonly method: "GET" | "POST";
  /** Beneath `/v1`. */
  readonly path: string;
  readonly body?: unknown;
}

/** An authenticated request whose response is handed back UNREAD. */
export interface AdminRawHttp {
  request(input: AdminRawRequest): Promise<Response>;
}

/**
 * The raw transport over `fetch`, with the bearer token the caller resolved
 * from the sealed session. Redirects are NOT followed — the label download's
 * 302 is the answer, and following it would fetch the PDF into this server
 * for no reason.
 */
export function createAdminRawHttp(baseUrl: string, accessToken: string | null): AdminRawHttp {
  return {
    request(input) {
      const headers: Record<string, string> = {
        "x-request-id": crypto.randomUUID(),
      };
      if (accessToken !== null) {
        headers["authorization"] = `Bearer ${accessToken}`;
      }
      if (input.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      return fetch(buildUrl(baseUrl, input.path), {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
      });
    },
  };
}

async function failure(response: Response): Promise<AdminApiError> {
  let body: unknown;
  try {
    const parsed: unknown = await response.json();
    body = parsed;
  } catch {
    body = undefined;
  }
  return toApiError({ status: response.status, body });
}

export interface PrintedLabels {
  readonly pdf: Uint8Array;
  readonly count: number;
  /** Requested order ids that had no stored label. */
  readonly skippedOrderIds: readonly string[];
}

/** The merged PDF of the orders' stored labels, in the order given. */
export async function printLabels(
  http: AdminRawHttp,
  orderIds: readonly string[],
): Promise<PrintedLabels> {
  const response = await http.request({
    method: "POST",
    path: "/admin/fulfilment/labels/print",
    body: { orderIds },
  });
  if (!response.ok) {
    throw await failure(response);
  }

  // Header values are external input like any body: parsed, never assumed.
  const skippedRaw = response.headers.get(PRINT_LABELS_SKIPPED_HEADER) ?? "";
  const skippedOrderIds = skippedRaw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => idSchema.safeParse(value).success);
  const count = Number.parseInt(response.headers.get(PRINT_LABELS_COUNT_HEADER) ?? "", 10);

  const pdf = new Uint8Array(await response.arrayBuffer());
  return {
    pdf,
    count: Number.isFinite(count) ? count : orderIds.length - skippedOrderIds.length,
    skippedOrderIds,
  };
}

/** The short-lived signed URL the API's label endpoint redirects to. */
export async function labelDownloadUrl(http: AdminRawHttp, shipmentId: string): Promise<string> {
  const response = await http.request({
    method: "GET",
    path: `/admin/fulfilment/shipments/${shipmentId}/label`,
  });
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location !== null) {
    // Only an absolute http(s) URL is followed onward: this value becomes a
    // redirect in front of a staff browser.
    const url = URL.canParse(location) ? new URL(location) : null;
    if (url !== null && (url.protocol === "https:" || url.protocol === "http:")) {
      return url.toString();
    }
  }
  if (response.status >= 400) {
    throw await failure(response);
  }
  throw new AdminApiError({
    code: "UNPARSEABLE_RESPONSE",
    status: response.status,
    message: "The label endpoint did not answer with a redirect.",
  });
}

// ---------------------------------------------------------------------------
// Input narrowing for the server actions (a server action is a public
// endpoint: its arguments are re-parsed, never trusted for their static type).
// ---------------------------------------------------------------------------

/** `{ orderIds }` for generate: 1–100 unique UUIDs. */
export function parseGenerateOrderIds(orderIds: unknown): readonly string[] {
  return bulkLabelRequestSchema.parse({ orderIds }).orderIds;
}

/** `{ orderIds }` for print: 1–200 unique UUIDs. */
export function parsePrintOrderIds(orderIds: unknown): readonly string[] {
  return printLabelsRequestSchema.parse({ orderIds }).orderIds;
}

export function parseShipmentId(value: unknown): string {
  return idSchema.parse(value);
}

/** The caller-minted key: a UUID from `crypto.randomUUID()`, at most 128 chars. */
export function parseIdempotencyKey(value: unknown): string {
  return idempotencyKeySchema.parse(value);
}

const idempotencyKeySchema = z.string().trim().min(8).max(128);
