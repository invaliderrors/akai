import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { rateLimited } from "../auth.errors";
import type { RateLimitRule } from "../auth.policy";
import { AUTH_RATE_LIMITER, type AuthRateLimiter } from "../ports/rate-limiter.port";

export const RATE_LIMIT_KEY = "akai:rateLimit";

export interface RateLimitMetadata extends RateLimitRule {
  /** Distinguishes buckets so login and register do not share a budget. */
  readonly name: string;
}

/** `@RateLimit({ name: "login", limit: 10, windowMs: 900_000 })`. */
export const RateLimit = (metadata: RateLimitMetadata): CustomDecorator<string> =>
  SetMetadata(RATE_LIMIT_KEY, metadata);

/**
 * Per-IP fixed-window rate limiting for the auth endpoints.
 *
 * This is the FIRST of three layers, and it is the weakest on purpose:
 *
 *   1. this guard — cheap, per-process, stops a naive burst before it reaches
 *      the password hasher (which is deliberately expensive, and therefore a
 *      denial-of-service amplifier if left unguarded);
 *   2. durable account lockout in `customer.failedLoginCount` / `lockedUntil` —
 *      survives restarts and is shared across replicas, so it actually bounds a
 *      distributed attack against ONE account;
 *   3. the Postgres-backed throttler store from spec §5, which will make layer
 *      one shared across replicas too (followUps).
 *
 * Nothing here is an authorisation control, and no security property depends on
 * it alone.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_RATE_LIMITER) private readonly limiter: AuthRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") {
      return true;
    }

    const metadata = this.reflector.getAllAndOverride<RateLimitMetadata | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (metadata === undefined) {
      return true;
    }

    const request: unknown = context.switchToHttp().getRequest();
    const clientIp = extractClientIp(request);

    const decision = await this.limiter.consume(
      `${metadata.name}:${clientIp ?? "unknown"}`,
      metadata.limit,
      metadata.windowMs,
    );

    if (!decision.allowed) {
      throw rateLimited(decision.retryAfterSeconds);
    }

    return true;
  }
}

/**
 * Best-effort client IP.
 *
 * Reads `req.ip`, which Express populates from X-Forwarded-For ONLY when
 * `trust proxy` is configured. That configuration is deliberately not set here:
 * trusting the header without knowing how many proxies sit in front lets any
 * client spoof its address and reset its own rate-limit bucket at will. Setting
 * `trust proxy` to the real hop count is a deployment concern (followUps).
 */
export function extractClientIp(request: unknown): string | null {
  if (typeof request !== "object" || request === null) {
    return null;
  }

  if ("ip" in request && typeof request.ip === "string" && request.ip.length > 0) {
    return request.ip;
  }

  if ("socket" in request) {
    const { socket } = request;
    if (
      typeof socket === "object" &&
      socket !== null &&
      "remoteAddress" in socket &&
      typeof socket.remoteAddress === "string"
    ) {
      return socket.remoteAddress;
    }
  }

  return null;
}
