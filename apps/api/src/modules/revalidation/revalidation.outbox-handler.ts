import { Inject, Injectable } from "@nestjs/common";
import type { Logger } from "@akai/observability";

import { LOGGER } from "../observability/logger.module";
import type { OutboxHandler, OutboxMessage } from "../outbox/outbox.types";
import {
  REVALIDATION_CLIENT,
  type RevalidationClient,
} from "./revalidation.client";
import {
  REVALIDATION_TOPIC,
  revalidationPayloadSchema,
} from "./revalidation.types";

/**
 * OUTBOX CONSUMER for `storefront.revalidate`.
 *
 * Without it, a price change made in the admin dashboard stayed invisible on the
 * storefront until the 60-second ISR window happened to lapse — and, worse, the
 * WordPress hook that used to trigger revalidation is gone, so nothing at all
 * would have called it after the cutover.
 *
 * IDEMPOTENT BY NATURE, which is what makes at-least-once delivery safe here:
 * invalidating a cache tag twice has exactly the same effect as invalidating it
 * once. That is the reason this consumer needs no dedupe table while the payment
 * consumers do.
 */
@Injectable()
export class RevalidationOutboxHandler implements OutboxHandler {
  readonly topic = REVALIDATION_TOPIC;

  constructor(
    @Inject(REVALIDATION_CLIENT) private readonly client: RevalidationClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async handle(payload: unknown, message: OutboxMessage): Promise<void> {
    // Parsed, not cast. The row was serialised to JSONB, possibly by an older
    // deploy, so an unrecognised shape is a producer bug — thrown so it
    // dead-letters and surfaces at /admin/jobs rather than being marked done.
    const parsed = revalidationPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `Unrecognised revalidation payload on message ${message.id}: ${parsed.error.message}`,
      );
    }

    await this.client.revalidate(parsed.data.tags);

    this.logger.debug(
      { tags: parsed.data.tags, reason: parsed.data.reason },
      "Storefront cache tags revalidated",
    );
  }
}
