import type { INestApplication } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import type { Provider } from "@nestjs/common";

import { DEFAULT_AUTH_POLICY } from "../modules/auth/auth.policy";
import { systemClock } from "../modules/auth/ports/clock.port";
import { RolesGuard } from "../modules/auth/guards/roles.guard";
import { writePrincipal, type Principal } from "../modules/auth/security/principal";

/**
 * Test harness for controller suites that need a real authorisation decision.
 *
 * WHY THIS EXISTS: controller tests previously stood in for the global auth
 * guards with a one-line middleware that set `request.user` to a plain object,
 * because AuthModule did not exist when they were written. Now that
 * JwtAuthGuard and RolesGuard are registered as APP_GUARD in AppModule, a test
 * that keeps its own stand-in is testing a pipeline the application does not
 * run — and would keep passing after a change that broke the real one.
 *
 * So this helper supplies the REAL RolesGuard and attaches the principal
 * through the REAL `writePrincipal`, the same function JwtAuthGuard uses. Only
 * authentication is simulated (there is no token to verify in a unit test);
 * every authorisation decision below it is the production code path.
 */

/**
 * Provider that installs the canonical RolesGuard into a testing module.
 *
 * JwtAuthGuard is deliberately NOT installed: it would require AuthService, a
 * database and a signed token to produce a principal these tests supply
 * directly. `attachPrincipal` below takes its place, which is why it writes
 * through the same helper rather than assigning the field itself.
 */
export const rolesGuardProvider: Provider = {
  provide: APP_GUARD,
  useFactory: (reflector: Reflector): RolesGuard =>
    new RolesGuard(reflector, DEFAULT_AUTH_POLICY, systemClock),
  inject: [Reflector],
};

/**
 * Middleware that impersonates an authenticated caller.
 *
 * `read` is called per request rather than taking a fixed principal, so a suite
 * can flip callers between cases by reassigning one variable — the pattern the
 * existing suites already use.
 *
 * A `null` principal means anonymous: nothing is attached, which is exactly the
 * state JwtAuthGuard leaves a public route in when no credential is presented,
 * and what makes the 401 assertions meaningful.
 */
export function attachPrincipal(
  app: INestApplication,
  read: () => Principal | null,
): void {
  app.use((request: object, _response: unknown, next: () => void) => {
    const principal = read();
    if (principal !== null) {
      writePrincipal(request, principal);
    }
    next();
  });
}

/** A principal fixture with a FRESH second factor, valid for elevated routes. */
export function staffPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    customerId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    sessionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    role: "STAFF",
    twoFactorAssertedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * A CUSTOMER principal — WITH a fresh second factor, deliberately.
 *
 * Making the customer fixture 2FA-fresh means a 403 on an admin route can only
 * have come from the ROLE check. If it were stale, the test would pass for the
 * wrong reason and would keep passing even if the role check were deleted.
 */
export function customerPrincipal(overrides: Partial<Principal> = {}): Principal {
  return staffPrincipal({
    customerId: "3f2504e0-4f89-41d3-9a0c-0305e82c3303",
    role: "CUSTOMER",
    ...overrides,
  });
}
