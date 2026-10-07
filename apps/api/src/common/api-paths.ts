import { WOMPI_WEBHOOK_ROUTE } from "../modules/payments/webhook/wompi-webhook.controller";

/**
 * Routed paths that must be agreed on by BOTH Nest's router and raw Express.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT PART OF `main.ts`. `main.ts` calls
 * `bootstrap()` at import time, which loads and validates the environment and
 * calls `process.exit(1)` when it cannot. Anything importing it — a test, a
 * script — starts the server as a side effect. Constants that other code needs
 * to reference therefore cannot live there.
 */

/**
 * The version prefix every routed endpoint sits behind.
 *
 * Retrofitting a prefix once clients exist means either breaking them or
 * maintaining two routing tables, so it is applied from the start.
 */
export const API_GLOBAL_PREFIX = "v1";

/**
 * The fully-prefixed path of the Wompi event endpoint — what goes in the Wompi
 * dashboard's "URL de Eventos" as `https://<api-host>${WOMPI_WEBHOOK_PATH}`.
 *
 * Unlike Resend below, this route needs NO raw-body middleware: Wompi's
 * checksum covers named fields of the parsed body, not its bytes. The constant
 * exists so the documented URL and the routed one cannot drift.
 */
export const WOMPI_WEBHOOK_PATH = `/${API_GLOBAL_PREFIX}/${WOMPI_WEBHOOK_ROUTE}`;

/** The webhook route Resend posts delivery events to, below the version prefix. */
export const RESEND_WEBHOOK_ROUTE = "webhooks/resend";

/**
 * The fully-prefixed Express path of the Resend webhook.
 *
 * DERIVED, NEVER RETYPED. `setGlobalPrefix` rewrites Nest's router but not a
 * raw Express middleware mount, so this is the one place the two routing worlds
 * are reconciled by hand.
 * If it drifted, the raw-body middleware would silently never run and every
 * delivery would fail closed with RAW_BODY_UNAVAILABLE.
 */
export const RESEND_WEBHOOK_PATH = `/${API_GLOBAL_PREFIX}/${RESEND_WEBHOOK_ROUTE}`;
