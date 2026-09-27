import { z } from "zod";
import { idSchema, isoDateTimeSchema, paginatedSchema } from "./common";

/**
 * The background-job (transactional outbox) admin surface.
 *
 * WHAT IT IS FOR: producers commit a row in the same transaction as the state
 * change it describes, and a dispatcher drains them. When a handler keeps
 * failing the row is retried with backoff and eventually dead-lettered — and
 * until now nothing surfaced that. A stuck catalogue mirror or an undelivered
 * order email looked exactly like a healthy system from the outside.
 *
 * THE PAYLOAD IS DELIBERATELY NOT PART OF THIS CONTRACT. Outbox payloads carry
 * live password-reset tokens, verification links and raw customer addresses; the
 * one redactor available is a substring denylist over key names, and the email
 * topics use `to` for the address, which it does not cover. Serving them to
 * every STAFF user would turn an observability page into an account-takeover
 * surface, so the shape below exposes state and diagnostics and no payload at
 * all.
 */

/** Derived from the row, not stored — see `resolveJobState` on the server. */
export const jobStateSchema = z.enum([
  /** Waiting for its next attempt; `availableAt` may be in the future (backoff). */
  "PENDING",
  /** Has failed at least once and is still being retried. */
  "RETRYING",
  /** Gave up. Nothing will drain it without an operator. */
  "DEAD",
  /** Handled successfully. */
  "PROCESSED",
]);

export type JobState = z.infer<typeof jobStateSchema>;

export const jobSchema = z
  .object({
    id: idSchema,
    topic: z.string().min(1).max(64),
    state: jobStateSchema,
    attempts: z.number().int().min(0),
    /** Handler error text, for an operator. Never customer-facing. */
    lastError: z.string().max(1000).nullable(),
    /** When the dispatcher may next pick it up. */
    availableAt: isoDateTimeSchema,
    processedAt: isoDateTimeSchema.nullable(),
    deadAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    /**
     * True when NO handler is registered for this topic.
     *
     * The single most valuable fact on the page. The dispatcher treats an
     * unrouted topic as a failure, so such a row burns its whole retry budget
     * and dead-letters — while the producer looks like it worked. It is a
     * deployment defect, not a transient error, and it is invisible everywhere
     * else.
     */
    unrouted: z.boolean(),
  })
  .strict();

export type Job = z.infer<typeof jobSchema>;

export const paginatedJobsSchema = paginatedSchema(jobSchema);
export type PaginatedJobs = z.infer<typeof paginatedJobsSchema>;

/** Per-topic health, so an operator sees a backlog without paging the list. */
export const jobTopicSummarySchema = z
  .object({
    topic: z.string().min(1).max(64),
    pending: z.number().int().min(0),
    retrying: z.number().int().min(0),
    dead: z.number().int().min(0),
    processed: z.number().int().min(0),
    unrouted: z.boolean(),
    oldestPendingAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type JobTopicSummary = z.infer<typeof jobTopicSummarySchema>;

export const jobsSummarySchema = z
  .object({
    topics: z.array(jobTopicSummarySchema),
    /** Topics a handler is registered for, so the UI can name what is missing. */
    routedTopics: z.array(z.string()),
  })
  .strict();

export type JobsSummary = z.infer<typeof jobsSummarySchema>;

export const listJobsQuerySchema = z
  .object({
    cursor: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    state: jobStateSchema.optional(),
    topic: z.string().min(1).max(64).optional(),
  })
  .strict();

export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;
