import type { SendcloudConfig } from "@akai/config";
import type { Logger } from "@akai/observability";

import { NotConfiguredSendcloudClient } from "../../fulfilment/sendcloud/not-configured-sendcloud.client";
import { SendcloudClient } from "../../fulfilment/sendcloud/sendcloud.client";
import type { SendcloudPort } from "../../fulfilment/sendcloud/sendcloud.port";

/**
 * A Sendcloud binding with a TIGHT time budget, for calls a shopper is waiting
 * on: the pickup-point search and checkout's re-verification of the chosen
 * point (spec §3.2/§3.3).
 *
 * WHY A SECOND INSTANCE and not `SENDCLOUD_CLIENT`: that one is tuned for the
 * label worker — 10 s per attempt, 3 retries with backoff — which is right for
 * an outbox job and wrong for a checkout page, where it can hold a request for
 * well over half a minute before the customer sees "try again". Here: 5 s per
 * attempt and ONE retry. Both calls this serves are reads (plus the idempotent
 * availability check), so a retry is always safe.
 *
 * Its own token, so api-e2e can point it at the fake Sendcloud server
 * (`config.sendcloud.baseUrl` is a constant, not config).
 */
export const SENDCLOUD_INTERACTIVE_CLIENT = Symbol("SENDCLOUD_INTERACTIVE_CLIENT");

export const INTERACTIVE_TIMEOUT_MS = 5_000;
export const INTERACTIVE_MAX_RETRIES = 1;

export function createInteractiveSendcloudClient(
  config: SendcloudConfig | null,
  logger: Pick<Logger, "warn">,
): SendcloudPort {
  if (config === null) {
    return new NotConfiguredSendcloudClient();
  }
  return new SendcloudClient(
    {
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      timeoutMs: INTERACTIVE_TIMEOUT_MS,
      maxRetries: INTERACTIVE_MAX_RETRIES,
    },
    { logger },
  );
}
