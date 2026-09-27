import type { JobState } from "@akai/contracts";

/**
 * Display rules for the job list.
 *
 * Pure and outside the route module: `page.tsx` reaches server-only session code,
 * so anything beside it cannot be unit-tested from jsdom.
 *
 * TONES ARE NOT HERE ANY MORE — they live in `lib/status` under the `job`
 * domain, which keeps the argument this file used to carry: DEAD is `danger`
 * and RETRYING only `warning`, because they need different reactions. A
 * retrying job may still succeed unattended; a dead one never will, since
 * nothing drains it again without an operator. That is the same distinction
 * `canRetryJob` below acts on, which is why the two were worth stating twice
 * and are now stated once each, in the layer that owns them.
 */

/** Only a job that can still do useful work is worth offering a retry for. */
export function canRetryJob(state: JobState): boolean {
  return state === "DEAD" || state === "RETRYING";
}

/**
 * Whether a topic's backlog warrants attention.
 *
 * An UNROUTED topic is always worth attention regardless of counts: every
 * message it receives burns its retry budget and dead-letters while the producer
 * looks like it worked.
 */
export function topicNeedsAttention(summary: {
  dead: number;
  retrying: number;
  unrouted: boolean;
}): boolean {
  return summary.unrouted || summary.dead > 0 || summary.retrying > 0;
}
