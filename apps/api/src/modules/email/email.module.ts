import { Module } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";
import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { LoggingTransport } from "./adapters/logging.transport";
import { ResendTransport } from "./adapters/resend.transport";
import { ResendWebhookController } from "./webhook/resend-webhook.controller";
import { ResendWebhookService } from "./webhook/resend-webhook.service";
import { EmailAdminService } from "./email-admin.service";
import { EmailOutboxHandler } from "./email-outbox.handler";
import { EMAIL_PORT, EmailPortAdapter } from "./email-port.adapter";
import { EmailController } from "./email.controller";
import {
  DEFAULT_EMAIL_RETRY_POLICY,
  EMAIL_RETRY_POLICY,
  EMAIL_SLEEPER,
  EMAIL_TRANSPORT,
  type EmailRetryPolicy,
  type EmailTransport,
  type EmailTransportConfig,
  type Sleeper,
  type TransportLogger,
} from "./email.port";
import { EmailService } from "./email.service";

/**
 * Choose the transport from VALIDATED config.
 *
 * `libs/config` refuses to boot with `EMAIL_TRANSPORT` set to anything but
 * "resend" whenever a Resend credential is present. THERE IS NO SMTP ADAPTER —
 * the three transports below are in-memory, logging and resend — so any other
 * value falls through to `LoggingTransport`, which returns a fabricated
 * `local-000001` id and DISCARDS the mail: green logs, SENT rows in the email
 * log, and nothing delivered. This factory does not re-litigate the rule; it
 * trusts the config, which is the point of validating once at the boundary.
 *
 * The `resend` branch asserts the key's presence through a narrowing check
 * rather than `!`: the config schema's cross-field rule already guarantees it,
 * but a guarantee that lives in another file is not something the compiler can
 * see, and the banned non-null assertion is exactly how that gap normally gets
 * papered over.
 */
export function createEmailTransport(
  config: EmailTransportConfig,
  logger: TransportLogger,
): EmailTransport {
  if (config.EMAIL_TRANSPORT === "resend") {
    const apiKey = config.RESEND_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'EMAIL_TRANSPORT is "resend" but RESEND_API_KEY is empty. This should ' +
          "have been caught by the config schema's cross-field validation.",
      );
    }
    return new ResendTransport({ apiKey, from: config.EMAIL_FROM });
  }

  return new LoggingTransport(logger);
}

const sleeper: Sleeper = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/**
 * EmailModule — transactional email.
 *
 * Exports `EmailService` (typed, never-throwing) and `EMAIL_PORT` (the
 * @akai/contracts interface) so a consuming module can depend on whichever
 * suits it. Everything else stays internal: transports, the retry policy and
 * the renderer are implementation detail, and exporting them would let another
 * module bypass the idempotency claim and the event log.
 */
@Module({
  controllers: [EmailController, ResendWebhookController],
  providers: [
    ResendWebhookService,
    EmailService,
    EmailAdminService,
    EmailOutboxHandler,
    EmailPortAdapter,
    {
      provide: EMAIL_TRANSPORT,
      inject: [SERVER_CONFIG, LOGGER],
      useFactory: (config: ServerEnv, logger: Logger): EmailTransport =>
        createEmailTransport(config, logger),
    },
    {
      provide: EMAIL_SLEEPER,
      useValue: sleeper,
    },
    {
      provide: EMAIL_RETRY_POLICY,
      useValue: DEFAULT_EMAIL_RETRY_POLICY satisfies EmailRetryPolicy,
    },
    {
      provide: EMAIL_PORT,
      useExisting: EmailPortAdapter,
    },
  ],
  exports: [EmailService, EMAIL_PORT, EmailOutboxHandler],
})
export class EmailModule {}
