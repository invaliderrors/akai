import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { z } from "zod";
import { PRINCIPAL_REQUEST_KEY } from "../auth/security/principal";
import { CART_TOKEN_HEADER } from "./cart.constants";

/**
 * Who is asking, reduced to the only two facts the cart cares about.
 *
 * Both may be null: an anonymous first-time visitor has neither, and that is a
 * valid actor which results in a freshly minted cart. Neither field is trusted
 * on its own — CartService still proves ownership before returning a cart.
 */
export interface CartActor {
  /** Set only when an authenticated session was established by the auth guard. */
  readonly customerId: string | null;
  /** Raw anonymous-cart token as presented. Shape is validated downstream. */
  readonly cartToken: string | null;
}

/**
 * The authenticated principal, as attached to the request by the auth layer.
 *
 * READ AT `PRINCIPAL_REQUEST_KEY`, IMPORTED FROM THE AUTH LAYER THAT WRITES IT.
 *
 * This used to read `request.user`, from a time when AuthModule was a
 * placeholder and the property name it would attach was unknown. AuthModule
 * shipped and writes `akaiPrincipal` — so the read silently never matched, every
 * authenticated cart and checkout resolved as anonymous, and orders placed by a
 * signed-in customer were created as GUEST orders that never appeared in their
 * account. Nothing failed; the customerId was simply always null.
 *
 * Sharing the constant is the fix: the writer and the reader can no longer
 * disagree about the spelling.
 *
 * Deliberately NOT `.strict()`, unlike every request-body schema in the
 * platform. The distinction is meaningful: a request body is hostile input where
 * an unknown key may be an attempt to smuggle a field into a Prisma `data:`
 * spread, so unknown keys are rejected. This object is produced by our own auth
 * guard, and being permissive about extra properties avoids coupling the cart
 * module to the auth module's exact payload. zod strips what it does not
 * declare, so nothing extra reaches the service either way.
 */
const principalSchema = z.union([
  z.object({ customerId: z.string().uuid() }).transform((value) => value.customerId),
  z.object({ sub: z.string().uuid() }).transform((value) => value.sub),
]);

/**
 * Read the actor off a request without ever touching a loose type.
 *
 * Takes `unknown` rather than an Express `Request` so it is directly callable
 * from tests with a plain object literal, and so the properties it reads
 * (`user`, `headers`) — neither of which Express types — are narrowed
 * explicitly instead of being reached for through a cast to a wider request
 * interface.
 */
export function extractCartActor(request: unknown): CartActor {
  return {
    customerId: readCustomerId(request),
    cartToken: readCartToken(request),
  };
}

function readCustomerId(request: unknown): string | null {
  const user = readProperty(request, PRINCIPAL_REQUEST_KEY);
  if (user === undefined) {
    return null;
  }

  const parsed = principalSchema.safeParse(user);
  return parsed.success ? parsed.data : null;
}

/**
 * Pull the cart token out of the headers.
 *
 * A repeated header arrives as an array. Rather than picking the first element —
 * which lets a caller who controls a proxy present two tokens and have different
 * layers disagree about which one counts — a duplicated token header is treated
 * as no token at all.
 */
function readCartToken(request: unknown): string | null {
  const headers = readProperty(request, "headers");
  if (typeof headers !== "object" || headers === null) {
    return null;
  }

  const raw = readProperty(headers, CART_TOKEN_HEADER);
  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Narrow an unknown object's property to `unknown` without widening the object. */
function readProperty(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null || !(key in source)) {
    return undefined;
  }
  return (source as Record<string, unknown>)[key];
}

/**
 * Injects the resolved actor into a handler parameter.
 *
 * Handlers therefore never see the raw request, which is what stops a future
 * endpoint from reading `request.body.customerId` and trusting it.
 */
export const CurrentCartActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CartActor =>
    extractCartActor(context.switchToHttp().getRequest<unknown>()),
);
