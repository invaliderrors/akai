import { Module } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";

import { SERVER_CONFIG } from "../config/config.module";
import {
  HttpRevalidationClient,
  REVALIDATION_CLIENT,
  type RevalidationClient,
} from "./revalidation.client";
import { RevalidationOutboxHandler } from "./revalidation.outbox-handler";

/**
 * RevalidationModule — signed storefront cache invalidation.
 *
 * The storefront's `/api/revalidate` route verifies an HMAC over the raw body.
 * THIS MODULE IS ITS ONLY CALLER: without it nothing invalidates the storefront's
 * ISR cache, and a price or stock edit stays invisible until the tag expires on
 * its own. `REVALIDATE_SIGNING_SECRET` is a REQUIRED key in `libs/config`, so the
 * two sides cannot boot with a mismatched secret.
 *
 * The direction is worth stating plainly, because the module name reads
 * ambiguously: this API is the SENDER. It does not expose a revalidation
 * endpoint of its own and must not — an inbound "purge my cache" route on the
 * API would be a second, differently-authenticated path to the same effect.
 *
 * NO CONTROLLER, therefore, and no service other than the outbox consumer. The
 * handler is exported for OutboxModule to register alongside the email and
 * catalog-mirror consumers.
 */
@Module({
  providers: [
    RevalidationOutboxHandler,
    {
      provide: REVALIDATION_CLIENT,
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerEnv): RevalidationClient =>
        new HttpRevalidationClient({
          storefrontUrl: config.STOREFRONT_URL,
          signingSecret: config.REVALIDATE_SIGNING_SECRET,
        }),
    },
  ],
  exports: [RevalidationOutboxHandler],
})
export class RevalidationModule {}
