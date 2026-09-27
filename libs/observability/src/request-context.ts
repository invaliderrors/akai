import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Request-scoped correlation context.
 *
 * The goal: one customer complaint ("my order AK-2026-000123 never confirmed")
 * can be traced from the HTTP request, through the queued job, to the outbound
 * gateway call, by grepping ONE id.
 *
 * AsyncLocalStorage rather than passing a context parameter everywhere: the
 * propagation has to survive queue handlers and Prisma middleware that never
 * see the original request object.
 */

export interface RequestContext {
  readonly requestId: string;
  readonly customerId?: string;
  readonly role?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The header we accept and echo. Standard enough that proxies preserve it. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Derive a request id from an inbound header, or mint one.
 *
 * An inbound value is accepted so a trace started at the edge (or in the
 * dashboard's BFF) stays continuous, but it is length-capped and
 * character-filtered first: the id lands in log lines and response headers, and
 * an unvalidated one is a log-injection vector (a newline lets an attacker forge
 * whole log entries).
 */
export function normaliseRequestId(candidate: unknown): string {
  if (typeof candidate !== "string") {
    return randomUUID();
  }
  const cleaned = candidate.trim().replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned.length >= 8 && cleaned.length <= 64 ? cleaned : randomUUID();
}

/** Run a callback with the given context bound for its entire async subtree. */
export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

/** The active context, or undefined outside a request (cron, boot). */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The active request id, or "system" outside a request.
 *
 * Returns a usable string rather than throwing, because the error envelope
 * requires a requestId and a logging failure must never be the reason an error
 * response cannot be produced.
 */
export function getRequestId(): string {
  return storage.getStore()?.requestId ?? "system";
}
