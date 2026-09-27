import { Module } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";
import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { AuthController } from "./auth.controller";
import { AUTH_REPOSITORY } from "./auth.repository";
import { AUTH_POLICY, DEFAULT_AUTH_POLICY } from "./auth.policy";
import {
  AUTH_SECRETS,
  AuthService,
  REFRESH_TOKEN_TTL_MS,
  type AuthSecrets,
} from "./auth.service";
import { PrismaAuthRepository } from "./prisma-auth.repository";
import {
  ACCESS_TOKEN_OPTIONS,
  AccessTokenService,
  type AccessTokenOptions,
} from "./crypto/access-token.service";
import { parseDurationMs } from "./crypto/duration";
import { ScryptPasswordHasher } from "./crypto/scrypt-password-hasher";
import {
  DEFAULT_TOTP_OPTIONS,
  TOTP_OPTIONS,
  TotpService,
} from "./crypto/totp.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { AuthRateLimitGuard } from "./guards/rate-limit.guard";
import { RolesGuard } from "./guards/roles.guard";
import { AUTH_EVENT_PUBLISHER } from "./ports/auth-events.port";
import { OutboxAuthEventPublisher } from "./ports/outbox-auth-event.publisher";
import {
  AlwaysAllowCaptchaVerifier,
  CAPTCHA_VERIFIER,
  type CaptchaVerifier,
} from "./ports/captcha.port";
import { TurnstileCaptchaVerifier } from "./ports/turnstile-captcha.verifier";
import { CLOCK, systemClock, type Clock } from "./ports/clock.port";
import {
  PASSWORD_HASHER,
  PASSWORD_HASHER_OPTIONS,
  type PasswordHasherOptions,
} from "./ports/password-hasher.port";
import { AUTH_RATE_LIMITER } from "./ports/rate-limiter.port";
import { PostgresAuthRateLimiter } from "./ports/postgres-rate-limiter";
import {
  RATE_LIMIT_STORE,
  PrismaRateLimitStore,
  type RateLimitStore,
} from "./ports/rate-limit-store.port";

/**
 * Identifies this API as the issuer and the intended audience of its own access
 * tokens. Constants rather than config: they are a protocol detail, and an
 * operator able to change them could silently make tokens minted for a
 * different service acceptable here.
 */
const TOKEN_ISSUER = "akai-api";
const TOKEN_AUDIENCE = "akai-dashboard";

/**
 * AuthModule — credentials, sessions, tokens and authorisation.
 *
 * Every value that could vary (cost factors, TTLs, lockout thresholds, the
 * clock) is a provider rather than a constant reached for at the point of use.
 * That is what lets auth.service.test.ts assert the security boundaries
 * directly — the tenth failed login locking the account, an expired token being
 * refused, a replayed refresh token revoking its whole family — with no
 * database, no sleeping and no module mocking.
 *
 * NOT REGISTERED HERE: the global APP_GUARD bindings. `JwtAuthGuard` and
 * `RolesGuard` are exported for AppModule to install globally, because doing it
 * from this module would apply deny-by-default to every route in the API the
 * moment it is imported — a change that belongs in the integration commit
 * alongside a `@Public()` audit of the other modules, not smuggled in here.
 * See followUps.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessTokenService,
    TotpService,
    JwtAuthGuard,
    RolesGuard,
    AuthRateLimitGuard,

    { provide: CLOCK, useValue: systemClock },
    { provide: AUTH_POLICY, useValue: DEFAULT_AUTH_POLICY },
    { provide: TOTP_OPTIONS, useValue: DEFAULT_TOTP_OPTIONS },

    { provide: AUTH_REPOSITORY, useClass: PrismaAuthRepository },
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },

    {
      provide: PASSWORD_HASHER_OPTIONS,
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerEnv): PasswordHasherOptions => ({
        memoryKib: config.ARGON2_MEMORY_KIB,
        timeCost: config.ARGON2_TIME_COST,
      }),
    },

    {
      provide: ACCESS_TOKEN_OPTIONS,
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerEnv): AccessTokenOptions => ({
        secret: config.JWT_ACCESS_SECRET,
        ttlMs: parseDurationMs(config.JWT_ACCESS_TTL),
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        // 30s absorbs ordinary NTP drift between signer and verifier without
        // meaningfully extending a revoked token's life.
        clockToleranceSeconds: 30,
      }),
    },

    {
      provide: REFRESH_TOKEN_TTL_MS,
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerEnv): number =>
        parseDurationMs(config.REFRESH_TOKEN_TTL),
    },

    {
      provide: AUTH_SECRETS,
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerEnv): AuthSecrets => ({
        // HKDF-separated inside secret-box.ts, so the derived TOTP key is
        // cryptographically independent of the JWT signing key despite sharing
        // a root secret.
        totpEncryptionRootSecret: config.JWT_ACCESS_SECRET,
      }),
    },

    {
      // Real binding: writes an `email` outbox row for the token-bearing events
      // (verify-email, reset-password) so the worker's dispatcher delivers them.
      // Replaces the no-op InMemory collector that silently dropped every auth
      // mail. See OutboxAuthEventPublisher for the post-commit durability note.
      provide: AUTH_EVENT_PUBLISHER,
      useClass: OutboxAuthEventPublisher,
    },

    // The rate-limiter store is Postgres, not an in-process Map (spec §5). This
    // is what makes login/registration throttling hold under horizontal scaling
    // — the deployment target — instead of being bypassed the moment a second
    // instance runs. The counter is shared; the limiter itself is stateless.
    { provide: RATE_LIMIT_STORE, useClass: PrismaRateLimitStore },
    {
      provide: AUTH_RATE_LIMITER,
      inject: [RATE_LIMIT_STORE, CLOCK],
      useFactory: (store: RateLimitStore, clock: Clock): PostgresAuthRateLimiter =>
        new PostgresAuthRateLimiter(store, clock),
    },

    {
      // The real Cloudflare adapter whenever a secret is configured; the
      // fail-open no-op only in dev/test/CI where no key is set (libs/config
      // makes the key mandatory in production, so this can never silently ship
      // the no-op). This is the difference between a required `turnstileToken`
      // field that is actually checked and one that decorates the request.
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
  exports: [
    AuthService,
    // Exported so AppModule can install them as APP_GUARD, and so other domain
    // modules can reference @Roles and the principal helpers.
    JwtAuthGuard,
    RolesGuard,
    AuthRateLimitGuard,
    AUTH_POLICY,
    CLOCK,
  ],
})
export class AuthModule {}
