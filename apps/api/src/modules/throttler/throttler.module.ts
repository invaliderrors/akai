import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { systemClock, type Clock } from "../auth/ports/clock.port";
import { PostgresAuthRateLimiter } from "../auth/ports/postgres-rate-limiter";
import {
  PrismaRateLimitStore,
  RATE_LIMIT_STORE,
  type RateLimitStore,
} from "../auth/ports/rate-limit-store.port";
import { PUBLIC_RATE_LIMITER } from "./rate-limiter.port";
import { ThrottleGuard } from "./throttle.guard";

/**
 * The throttler's clock.
 *
 * A module-level constant rather than an injected `CLOCK` token: AuthModule owns
 * that token, and importing AuthModule here to borrow it would create a cycle
 * the moment auth wants a public throttle. The limiter's clock-dependent logic
 * (the Retry-After arithmetic) is already unit-tested inside auth against an
 * injected fake, so nothing here needs the seam.
 */
const PUBLIC_THROTTLER_CLOCK: Clock = systemClock;

/**
 * ThrottlerModule — volume control for the routes no credential gates.
 *
 * It was an empty `@Module({})` while the only limiter in the platform lived
 * inside AuthModule and was never exported. The consequence was concrete: every
 * public route — the whole catalog, the whole cart, checkout — had no limit of
 * any kind, and the storefront's own in-memory limiter (per-process, and its own
 * comment admits it) was doing the job in the one place that cannot do it
 * durably.
 *
 * NOT `@Global()`, though it was the obvious choice. Every module that uses
 * `@UseGuards(ThrottleGuard)` imports this one EXPLICITLY, because a global
 * throttler is only present when something happens to have pulled it into the
 * graph — and the graph is assembled differently in the DI tests, which compose
 * subsets of modules. Under `@Global()` those tests failed with "cannot resolve
 * PUBLIC_RATE_LIMITER", which is the mild version of the same problem: a
 * production composition that omitted this module would fail at boot in one
 * environment and not another. An explicit import makes "this controller is
 * throttled" a fact about its module rather than about the order of AppModule.
 *
 * WHY IT REACHES INTO `../auth/ports` FOR THE IMPLEMENTATION rather than owning
 * a copy: the counter must be THE SAME counter. `rate_limit_counter` is one
 * table, `PostgresAuthRateLimiter` is stateless decision logic over it, and
 * `PrismaRateLimitStore` holds the single atomic upsert that keeps the count
 * correct under concurrency. A second implementation of that SQL is a second
 * chance to get the ON CONFLICT window reset wrong, and that failure is silent —
 * a limiter that resets itself is a limiter that does not limit.
 *
 * The right long-term home for those two classes is THIS module, with AuthModule
 * importing them back. That move is a pure relocation across ~200 tested lines in
 * the most security-sensitive module in the API, so it is recorded as a followUp
 * rather than smuggled into an unrelated commit.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    ThrottleGuard,
    { provide: RATE_LIMIT_STORE, useClass: PrismaRateLimitStore },
    {
      provide: PUBLIC_RATE_LIMITER,
      inject: [RATE_LIMIT_STORE],
      useFactory: (store: RateLimitStore): PostgresAuthRateLimiter =>
        new PostgresAuthRateLimiter(store, PUBLIC_THROTTLER_CLOCK),
    },
  ],
  exports: [ThrottleGuard, PUBLIC_RATE_LIMITER],
})
export class ThrottlerModule {}
