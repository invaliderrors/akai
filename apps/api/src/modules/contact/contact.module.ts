import { Module } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ThrottlerModule } from "../throttler/throttler.module";
import {
  AlwaysAllowCaptchaVerifier,
  CAPTCHA_VERIFIER,
  type CaptchaVerifier,
} from "../auth/ports/captcha.port";
import { TurnstileCaptchaVerifier } from "../auth/ports/turnstile-captcha.verifier";
import { CLOCK, systemClock } from "../auth/ports/clock.port";
import { ContactController } from "./contact.controller";
import { ContactService } from "./contact.service";

/**
 * ContactModule — the contact form, with rate limiting and bot protection.
 *
 * This module is the contact form's ONLY destination — the storefront page posts
 * straight here, so an empty module means the form posts into a 404.
 *
 * WHY IT BINDS ITS OWN CAPTCHA VERIFIER instead of importing AuthModule: it needs
 * exactly one small provider from a module that also carries the password
 * hasher, the TOTP service, the session repository and both global guards.
 * Importing all of that to borrow a token would couple the contact form to auth's
 * whole dependency graph — and AuthModule does not export CAPTCHA_VERIFIER, so it
 * would also mean widening auth's public surface for a consumer that has nothing
 * to do with identity. The FACTORY is duplicated; the IMPLEMENTATION
 * (`TurnstileCaptchaVerifier`) is imported, so there is still exactly one
 * verifier in the codebase and one failure policy.
 *
 * The same reasoning gives it `systemClock` directly rather than auth's CLOCK
 * token: it is a two-line constant, and the alternative is an import cycle
 * waiting to happen.
 */
@Module({
  imports: [PrismaModule, ThrottlerModule],
  controllers: [ContactController],
  providers: [
    ContactService,
    { provide: CLOCK, useValue: systemClock },
    {
      // The real Cloudflare adapter whenever a secret is configured; the
      // fail-open no-op only in dev/test/CI. libs/config makes the key mandatory
      // in production, so the no-op cannot silently ship there.
      provide: CAPTCHA_VERIFIER,
      inject: [SERVER_CONFIG, LOGGER],
      useFactory: (config: ServerEnv, logger: Logger): CaptchaVerifier =>
        config.TURNSTILE_SECRET_KEY === undefined ||
        config.TURNSTILE_SECRET_KEY === ""
          ? new AlwaysAllowCaptchaVerifier()
          : new TurnstileCaptchaVerifier(
              { secretKey: config.TURNSTILE_SECRET_KEY },
              logger,
            ),
    },
  ],
})
export class ContactModule {}
