import { Module } from "@nestjs/common";
import type { SendcloudConfig, ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { SendcloudClient } from "./sendcloud/sendcloud.client";
import { NotConfiguredSendcloudClient } from "./sendcloud/not-configured-sendcloud.client";
import { SENDCLOUD_CLIENT, type SendcloudPort } from "./sendcloud/sendcloud.port";

/**
 * Choose the Sendcloud binding from VALIDATED config — `config.sendcloud` is
 * resolved once in `libs/config` (all-or-none, so it is either complete or
 * null) and nothing here reads the environment.
 *
 * Exported and taking only the slice it needs, so the choice is testable
 * without building a whole ServerEnv (the TranslationModule pattern).
 */
export function createSendcloudClient(
  config: SendcloudConfig | null,
  logger: Pick<Logger, "warn">,
): SendcloudPort {
  if (config === null) {
    return new NotConfiguredSendcloudClient();
  }
  return new SendcloudClient(
    { publicKey: config.publicKey, secretKey: config.secretKey, baseUrl: config.baseUrl },
    { logger },
  );
}

/**
 * FulfilmentModule — Sendcloud shipping (spec
 * docs/superpowers/specs/2026-09-24-sendcloud-shipping.md).
 *
 * WHAT EXISTS (Phases 1–2 of the plan): the vendor layer only.
 *  - `SENDCLOUD_CLIENT` (`SendcloudPort`) — `SendcloudClient` when
 *    `config.sendcloud` is set, `NotConfiguredSendcloudClient` otherwise.
 *  - `test-mode.ts` — `effectiveShippingOptionCode` / `servicePointIdForMode`,
 *    the `sendcloud:letter` substitution the label service must apply.
 *  - `FulfilmentError` — the coded refusals (`fulfilmentFailureReasonSchema`).
 *
 * WHAT DOES NOT EXIST YET, and where it goes: pickup-point search and checkout
 * verification (Phase 3, consumers of this port in the shipping/checkout
 * modules), the label service + `order-fulfilment` outbox handler + admin
 * controller (Phase 4–5 — BUILT, in `labels/LabelsModule`, which imports this
 * module for the client), tracking webhook + sweep (Phase 6, here),
 * zones/rates admin (Phase 5b). The data model for all of them is already in
 * place (migration 20260925120000_sendcloud_shipping).
 */
@Module({
  providers: [
    {
      provide: SENDCLOUD_CLIENT,
      inject: [SERVER_CONFIG, LOGGER],
      useFactory: (config: ServerEnv, logger: Logger): SendcloudPort =>
        createSendcloudClient(config.sendcloud, logger),
    },
  ],
  exports: [SENDCLOUD_CLIENT],
})
export class FulfilmentModule {}
