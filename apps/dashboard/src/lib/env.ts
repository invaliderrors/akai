import { z } from "zod";

/**
 * Dashboard environment configuration.
 *
 * Deliberately NOT `@akai/config`: that lib validates the API/worker surface
 * (DATABASE_URL, payment keys, SMTP) and refuses to boot without it. The
 * dashboard is a browser-facing Next app that must never hold those secrets, so
 * it validates its own, much smaller set. Same discipline, different surface.
 *
 * Validation is LAZY and memoised rather than executed at module load. A
 * top-level throw would fail `next build` on a machine with no runtime secrets,
 * which is a build-time failure for a runtime concern; instead the first
 * request that needs a value fails loudly with every missing key listed at once.
 */

const serverEnvSchema = z
  .object({
    /**
     * Where THIS process reaches the NestJS API. Server-to-server, so it may be
     * an internal hostname the browser cannot resolve — that is the point.
     */
    API_INTERNAL_URL: z.string().url(),

    /**
     * AES-GCM key material for the sealed session cookie.
     *
     * 32 chars minimum because the cookie is the only thing standing between an
     * attacker and a pair of live tokens. Rotating this value invalidates every
     * session in the fleet, which is the intended break-glass control.
     */
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),

    /** Spec §14 pins the name; kept configurable so staging and prod can differ. */
    SESSION_COOKIE_NAME: z.string().min(1).default("akai_session"),
  })
  .strict();

export type DashboardServerEnv = z.infer<typeof serverEnvSchema>;

let cached: DashboardServerEnv | null = null;

/**
 * Reads and validates the server-only environment.
 *
 * Reports EVERY problem in one throw. Fixing environment variables one
 * redeploy at a time is how a ten-minute misconfiguration becomes an hour.
 * The thrown message never echoes a value — an error string containing
 * SESSION_SECRET would land in a log aggregator within seconds.
 */
export function serverEnv(): DashboardServerEnv {
  if (cached !== null) {
    return cached;
  }

  const parsed = serverEnvSchema.safeParse({
    API_INTERNAL_URL: process.env.API_INTERNAL_URL,
    SESSION_SECRET: process.env.SESSION_SECRET,
    SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME,
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid dashboard environment — ${problems}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test seam. Production code never calls this. */
export function resetServerEnvCache(): void {
  cached = null;
}

/**
 * Browser-visible configuration.
 *
 * Each `process.env.NEXT_PUBLIC_*` is referenced as a STATIC member expression
 * because that is the only form Next's bundler can inline. A dynamic lookup
 * (`process.env[key]`) compiles to `undefined` in the browser with no warning.
 */
export const publicEnv = {
  /** Browser-reachable API origin. Unused while all traffic goes via the BFF. */
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "",
  /** Empty when Turnstile is not configured; the widget then renders nothing. */
  turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "",
  /**
   * Public origin of the shop, for the account menu's "Back to the shop".
   *
   * The SAME variable the storefront publishes itself under, so the two cannot
   * name different origins for one site. Empty when unset, and the account menu
   * then omits the row entirely rather than rendering `href=""`, which the
   * browser resolves to the current page.
   */
  storeUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "",
} as const;

/** True in a real deployment; drives the `Secure` cookie attribute. */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
