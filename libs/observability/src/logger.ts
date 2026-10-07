import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * Structured JSON logging with PII redaction.
 *
 * Logs are the most common accidental PII exfiltration route in an ecommerce
 * backend: a well-meaning `logger.info({ order })` ships a customer's full name,
 * address and email to whatever third-party aggregator is configured.
 *
 * Redaction is therefore configured ONCE, here, and applied by the logger
 * itself rather than trusted to each call site.
 */

/**
 * Redaction paths.
 *
 * Wildcards (`*`) cover one level, so both `req.body.password` and
 * `order.customer.email` style shapes are caught without enumerating every
 * nesting. Erring toward over-redaction is correct: a redacted field can be
 * recovered from the database, a leaked one cannot be unleaked.
 */
export const REDACT_PATHS: readonly string[] = [
  // Credentials and tokens
  "password",
  "newPassword",
  "currentPassword",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "totpSecret",
  "recoveryCodes",
  "authorization",
  "cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "*.password",
  "*.token",
  "*.passwordHash",

  // Personal data
  "email",
  "phone",
  "firstName",
  "lastName",
  "line1",
  "line2",
  "postalCode",
  "*.email",
  "*.phone",
  "*.firstName",
  "*.lastName",
  "*.line1",
  "*.line2",
  "*.postalCode",

  // Payment-adjacent. We never hold a PAN, but a webhook payload might carry
  // card metadata, and there is no reason for it to be in a log line.
  "cardLast4",
  "*.cardLast4",
  // Provider-neutral: `client_secret` is a conventional name for a
  // browser-visible payment handle across gateways, not a Stripe-only field.
  "*.client_secret",
  // Wompi. The events secret in particular is the ONLY thing that makes a
  // checksum mean anything — it is the entire security boundary on the webhook
  // route — so a single leaked log line is a forgeable "order paid" event. The
  // integrity secret signs checkout amounts; the private key reads transactions.
  "privateKey",
  "*.privateKey",
  "integritySecret",
  "*.integritySecret",
  "eventsSecret",
  "*.eventsSecret",
  "WOMPI_PRIVATE_KEY",
  "WOMPI_INTEGRITY_SECRET",
  "WOMPI_EVENTS_SECRET",
];

export interface LoggerConfig {
  readonly level: string;
  readonly nodeEnv: string;
  readonly serviceName: string;
}

/**
 * Build the root logger.
 *
 * JSON in every environment including development. Pretty-printing is a
 * deliberate non-feature: the moment dev logs look different from production
 * logs, dev stops exercising the format that actually gets shipped, and
 * redaction bugs go unnoticed until they are in production.
 */
export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: {
      service: config.serviceName,
      env: config.nodeEnv,
    },
    redact: {
      paths: [...REDACT_PATHS],
      censor: "[redacted]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // Emit `"level":"info"` rather than pino's default numeric level, so log
      // aggregators can filter without a translation table.
      level: (label) => ({ level: label }),
    },
  };

  return pino(options);
}

export type { Logger };
