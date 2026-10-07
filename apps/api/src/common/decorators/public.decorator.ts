import { SetMetadata, type CustomDecorator } from "@nestjs/common";

export const IS_PUBLIC_KEY = "akai:isPublic";

/**
 * Marks a route as reachable without authentication.
 *
 * The API is DENY-BY-DEFAULT: a global JwtAuthGuard rejects everything unless a
 * handler opts out with this decorator. That direction matters — with an
 * allow-by-default guard, forgetting to protect a new admin endpoint silently
 * exposes it, whereas forgetting to mark a new public endpoint merely makes it
 * 401 in an obvious way during development.
 *
 * Applied today to health checks and the webhooks (which authenticate via
 * signature verification, not a session).
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
