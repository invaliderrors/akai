import { type ServerEnv, serverEnvSchema } from "./schema";

/**
 * Boot-time config loading. Fails fast, loudly, and with EVERY problem listed.
 */

/**
 * Thrown when the environment is invalid. Carries the structured issue list so
 * a deploy pipeline can machine-read it, while `message` stays human-readable
 * for the operator staring at a crashed container.
 */
export class ConfigValidationError extends Error {
  public readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    const detail = issues
      .map((issue) => `  • ${issue.path}: ${issue.message}`)
      .join("\n");

    super(
      `Invalid environment configuration — refusing to start.\n\n${detail}\n\n` +
        `All ${issues.length} problem(s) are listed above. See .env.example for ` +
        `the full set of variables and their expected shape.`,
    );

    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Validate a raw environment record into a typed config object.
 *
 * Takes the source explicitly rather than reading `process.env` internally so
 * tests can exercise it without mutating global state. `loadServerConfig()`
 * below is the production entry point.
 *
 * Reports ALL issues at once. Fixing one missing variable, redeploying, and
 * discovering the next one is a miserable and entirely avoidable loop.
 */
export function parseServerEnv(source: NodeJS.ProcessEnv): ServerEnv {
  const result = serverEnvSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      // Deliberately never echoes the received VALUE: these are secrets, and
      // a validation error is frequently the first thing shipped to a log
      // aggregator a third party can read.
      message: issue.message,
    }));

    throw new ConfigValidationError(issues);
  }

  return result.data;
}

let cached: ServerEnv | null = null;

/**
 * The production entry point. Call once during bootstrap, BEFORE `listen()`.
 *
 * Memoised so importing modules can call it freely without re-validating, and
 * so the process observes one consistent snapshot of its configuration even if
 * something mutates `process.env` later.
 */
export function loadServerConfig(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  cached ??= parseServerEnv(source);
  return cached;
}

/** Test-only: drops the memoised snapshot. Never call this from production code. */
export function resetServerConfigCache(): void {
  cached = null;
}

/**
 * Redact a config object for logging.
 *
 * Startup logs routinely dump configuration, and that is exactly how a signing
 * key ends up in a log aggregator. This allowlists the keys that are safe to
 * print rather than blocklisting the dangerous ones — a blocklist silently
 * fails open the moment a new secret is added to the schema.
 */
const LOGGABLE_KEYS = [
  "NODE_ENV",
  "PORT",
  "LOG_LEVEL",
  "EMAIL_TRANSPORT",
  "EMAIL_FROM",
  "CONTACT_INBOX_EMAIL",
  // Wompi: the public key only. WOMPI_PRIVATE_KEY, WOMPI_INTEGRITY_SECRET and
  // WOMPI_EVENTS_SECRET are deliberately ABSENT and therefore redacted —
  // `load.test.ts` asserts it, so re-adding one is a failing test.
  "WOMPI_PUBLIC_KEY",
  // Which environment the process actually resolved to. The single most useful
  // line in a startup log when a payment behaves unexpectedly, and it carries no
  // secret — the credentials it selects are redacted by omission like the rest.
  "WOMPI_ENVIRONMENT",
  "PAYMENTS_ENABLED",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "CORS_ALLOWED_ORIGINS",
  "STOREFRONT_URL",
  "DASHBOARD_URL",
  "ARGON2_MEMORY_KIB",
  "ARGON2_TIME_COST",
  "JWT_ACCESS_TTL",
  "REFRESH_TOKEN_TTL",
] as const satisfies ReadonlyArray<keyof ServerEnv>;

export function redactedConfig(config: ServerEnv): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of LOGGABLE_KEYS) {
    output[key] = config[key];
  }
  return output;
}
