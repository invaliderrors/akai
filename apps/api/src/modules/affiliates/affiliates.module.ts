import { Module } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ThrottlerModule } from "../throttler/throttler.module";
import { AuthModule } from "../auth/auth.module";
import {
  AlwaysAllowCaptchaVerifier,
  CAPTCHA_VERIFIER,
  type CaptchaVerifier,
} from "../auth/ports/captcha.port";
import { TurnstileCaptchaVerifier } from "../auth/ports/turnstile-captcha.verifier";
import { CLOCK, systemClock } from "../auth/ports/clock.port";
import { AffiliateApplicationController } from "./affiliate-application.controller";
import { AffiliateApplicationService } from "./affiliate-application.service";
import { AdminAffiliatesController } from "./admin-affiliates.controller";
import { AdminAffiliateLinksController } from "./admin-affiliate-links.controller";
import { PartnerController } from "./partner.controller";
import { PartnerLinksController } from "./partner-links.controller";
import { AffiliateAdminService } from "./affiliate-admin.service";
import { AffiliateLinksService } from "./affiliate-links.service";

/**
 * AffiliatesModule — the public application form (§5), the admin affiliates
 * screen (§14), partner dashboard logins, and vanity links, together.
 *
 * IMPORTS `AuthModule` FOR ITS SERVICE, not just borrowed pieces of it —
 * unlike the captcha verifier below, partner-login activation genuinely
 * needs `AuthService.requestPasswordReset`, the same flow an ordinary
 * customer's forgotten-password link goes through. `AuthModule` exports
 * `AuthService` for exactly this kind of cross-module reuse.
 *
 * BINDS ITS OWN CAPTCHA VERIFIER, exactly like `ContactModule` — see that
 * module's own doc comment for why: one small provider borrowed from a
 * module that would otherwise drag in auth's whole dependency graph, and
 * `AuthModule` does not export `CAPTCHA_VERIFIER` anyway. The IMPLEMENTATION
 * is imported, not duplicated, so there is still exactly one verifier in the
 * codebase and one failure policy.
 */
@Module({
  imports: [PrismaModule, ThrottlerModule, AuthModule],
  controllers: [
    AffiliateApplicationController,
    AdminAffiliatesController,
    AdminAffiliateLinksController,
    PartnerController,
    PartnerLinksController,
  ],
  providers: [
    AffiliateApplicationService,
    AffiliateAdminService,
    AffiliateLinksService,
    { provide: CLOCK, useValue: systemClock },
    {
      provide: CAPTCHA_VERIFIER,
      inject: [SERVER_CONFIG, LOGGER],
      useFactory: (config: ServerEnv, logger: Logger): CaptchaVerifier =>
        config.TURNSTILE_SECRET_KEY === undefined || config.TURNSTILE_SECRET_KEY === ""
          ? new AlwaysAllowCaptchaVerifier()
          : new TurnstileCaptchaVerifier({ secretKey: config.TURNSTILE_SECRET_KEY }, logger),
    },
  ],
})
export class AffiliatesModule {}
