import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { extractClientIp } from "../auth/guards/rate-limit.guard";
import { PUBLIC_RATE_LIMITER, type PublicRateLimiter } from "./rate-limiter.port";
import { THROTTLE_KEY, type ThrottleRule } from "./throttle.decorator";

/**
 * Rate limiting for the PUBLIC surface — catalog, cart, shipping quotes,
 * checkout and the contact form.
 *
 * WHY IT IS NOT THE AUTH GUARD: `AuthRateLimitGuard` is registered inside
 * AuthModule and is not exported to the rest of the graph, so every public route
 * in the API was entirely unlimited. Those routes are reachable by definition —
 * no credential gates them — which makes them the surface where a limiter
 * matters MOST, not least. `POST /v1/cart/items` in a loop reserves nothing but
 * does force a variant re-read per call; `POST /v1/contact` turns an anonymous
 * request into an outbound email.
 *
 * It shares the DURABLE Postgres counter with auth rather than keeping its own
 * in-process Map. A per-process limiter is bypassed by the second replica, and
 * the deployment target is horizontal.
 *
 * WHAT IT IS NOT: an authorisation control. Nothing here decides who may do
 * what. It bounds volume, and every route it guards is independently correct
 * without it.
 *
 * FAIL-OPEN ON STORE FAILURE, deliberately. If Postgres cannot serve the counter
 * the request is allowed through and the failure is surfaced by the exception it
 * would otherwise have thrown. Coupling the catalog's availability to the rate
 * limiter's availability would let a limiter incident take the storefront down —
 * trading a bounded abuse window for a total outage, which is the wrong trade for
 * a mitigation layer.
 */
@Injectable()
export class ThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PUBLIC_RATE_LIMITER) private readonly limiter: PublicRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Non-HTTP execution contexts (there are none today, but the outbox runner
    // is a Nest context) carry no client to attribute a bucket to.
    if (context.getType() !== "http") {
      return true;
    }

    const rule = this.reflector.getAllAndOverride<ThrottleRule | undefined>(
      THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (rule === undefined) {
      return true;
    }

    const request: unknown = context.switchToHttp().getRequest();
    const key = buildThrottleKey(rule, extractClientIp(request));

    const decision = await this.limiter.consume(key, rule.limit, rule.windowMs);
    if (decision.allowed) {
      return true;
    }

    throw new HttpException(
      `Too many requests. Retry in ${String(decision.retryAfterSeconds)} seconds.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * The bucket key: `public:<rule>:<client>`.
 *
 * Pure and exported so the key derivation is assertable without a Nest context.
 * The `public:` prefix namespaces these counters away from auth's, which share
 * the same `rate_limit_counter` table — without it a bucket named "login" in one
 * module and "login" in another would silently share a budget.
 *
 * An unattributable client collapses to a single shared "unknown" bucket. That
 * is deliberately the STRICT choice: it means requests we cannot attribute
 * compete with each other for one allowance rather than each getting a fresh
 * one, so losing the client IP tightens the limit instead of removing it.
 */
export function buildThrottleKey(rule: ThrottleRule, clientIp: string | null): string {
  return `public:${rule.name}:${clientIp ?? "unknown"}`;
}
