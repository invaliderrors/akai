import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { AuthService } from "../auth.service";
import { notAuthenticated } from "../auth.errors";
import { toPrincipal, writePrincipal } from "../security/principal";

/**
 * The deny-by-default authentication guard (spec §8).
 *
 * Registered globally, so EVERY route requires a valid session unless it
 * carries `@Public()`. The direction matters: with an allow-by-default guard,
 * forgetting to protect a new admin endpoint silently exposes it, whereas
 * forgetting to mark a new public endpoint merely 401s obviously in
 * development.
 *
 * This guard authenticates only. Authorisation is RolesGuard's job, and the two
 * are separate so that "who are you" and "may you do this" fail with different
 * status codes and cannot be conflated.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Non-HTTP contexts (the worker's scheduled jobs) have no request to
    // authenticate. Returning true here rather than throwing keeps this guard
    // from breaking a context it was never meant to police.
    if (context.getType() !== "http") {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request: unknown = context.switchToHttp().getRequest();
    if (typeof request !== "object" || request === null) {
      throw notAuthenticated();
    }

    const token = extractBearerToken(request);

    if (isPublic === true) {
      // A public route still resolves a principal WHEN one is presented, so
      // endpoints that behave differently for a signed-in visitor (a cart that
      // knows your saved address) can read it — while an absent or invalid
      // token stays anonymous rather than becoming a 401.
      if (token !== null) {
        const user = await this.auth.authenticate(token);
        if (user !== null) {
          writePrincipal(request, toPrincipal(user));
        }
      }
      return true;
    }

    if (token === null) {
      throw notAuthenticated();
    }

    const user = await this.auth.authenticate(token);
    if (user === null) {
      // One message for every failure mode — expired, forged, revoked session,
      // deleted customer. Distinguishing them tells an attacker which of their
      // guesses was closest.
      throw notAuthenticated();
    }

    writePrincipal(request, toPrincipal(user));
    return true;
  }
}

/**
 * Extracts a bearer token from the Authorization header.
 *
 * The header is read from an `unknown` request and narrowed, rather than typed
 * via an `as` cast — Express's own types do not guarantee `headers` exists or
 * that a given header is a string (Node models repeated headers as `string[]`).
 */
export function extractBearerToken(request: object): string | null {
  if (!("headers" in request)) {
    return null;
  }
  const { headers } = request;
  if (typeof headers !== "object" || headers === null) {
    return null;
  }
  if (!("authorization" in headers)) {
    return null;
  }

  const { authorization } = headers;
  if (typeof authorization !== "string") {
    return null;
  }

  const [scheme, ...rest] = authorization.split(" ");
  // Case-insensitive scheme, exactly one token, no empty value. Being strict
  // here avoids a class of parser-differential bugs where a proxy and the app
  // disagree about which part of the header is the credential.
  if (scheme === undefined || scheme.toLowerCase() !== "bearer" || rest.length !== 1) {
    return null;
  }

  const token = rest[0];
  return token === undefined || token.length === 0 ? null : token;
}
