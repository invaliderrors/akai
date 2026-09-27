import type { EmailStatus } from "@akai/contracts";

/**
 * Display rules for the delivery log.
 *
 * Pure, and outside the route module for the usual reason: `page.tsx` reaches
 * `createServerApiClient` → `lib/session/server.ts`, which throws when pulled
 * into client code, so anything defined beside it cannot be unit-tested.
 *
 * TONES ARE NOT HERE ANY MORE — they live in `lib/status` under the `email`
 * domain, carrying the argument this file used to make: BOUNCED and COMPLAINED
 * are `danger` while FAILED is only `warning`, and the asymmetry is deliberate.
 * A complaint is a spam report, which damages sending reputation for every
 * other customer, and a hard bounce usually means the address is dead. Neither
 * is a transient problem an operator can ignore, unlike FAILED — which is our
 * own send erroring and is retryable. That is the same split `canRetry` below
 * acts on, from the other side.
 */

/**
 * Whether a retry is offered.
 *
 * MIRRORS THE API, which refuses a retry for SENT and DELIVERED with a 409
 * ("retrying would send it twice"). Offering a button the server will reject is
 * how an operator learns to distrust the UI, so the rule is stated on both
 * sides — the API's is the one that is enforced.
 *
 * BOUNCED and COMPLAINED are excluded for a different reason: the message was
 * accepted and then rejected by the recipient's side, so re-sending the same
 * thing to the same address repeats the bounce and, for a complaint, mails
 * someone who explicitly reported it as spam.
 */
export function canRetry(status: EmailStatus): boolean {
  return status === "FAILED" || status === "QUEUED";
}

/**
 * Whether the status is still expected to change.
 *
 * SENT means the provider accepted it and nothing has come back yet. It advances
 * to DELIVERED, BOUNCED or COMPLAINED only when a provider webhook says so — so
 * a row sitting at SENT is either in flight or the webhook is not wired up, and
 * an operator needs to be able to tell those apart from a finished send.
 */
export function isPending(status: EmailStatus): boolean {
  return status === "QUEUED" || status === "SENT";
}
