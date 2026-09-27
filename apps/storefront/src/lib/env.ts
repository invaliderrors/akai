import { z } from "zod";

/**
 * Runtime configuration, read from `process.env` at request time — never baked
 * into the build — so one image serves every environment. Public URLs the
 * browser needs are handed to islands as props from here, for the same reason.
 */
const serverEnvSchema = z
  .object({
    /** How the server reaches the API (inside the compose network in Docker). */
    API_INTERNAL_URL: z.string().url(),
    /** How the BROWSER reaches the API — cart and checkout calls go direct. */
    PUBLIC_API_URL: z.string().url(),
    /** The dashboard hosts sign-in, sign-up and the customer account. */
    PUBLIC_DASHBOARD_URL: z.string().url(),
    /** Shared with the dashboard: one sealed cookie is one sign-in for both. */
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    SESSION_COOKIE_NAME: z.string().min(1).default("akai_session"),
    /** HMAC key the API signs `/api/revalidate` calls with. */
    REVALIDATE_SIGNING_SECRET: z.string().min(32),
  })
  .strict();

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached !== null) return cached;

  const parsed = serverEnvSchema.safeParse({
    API_INTERNAL_URL: process.env.API_INTERNAL_URL,
    PUBLIC_API_URL: process.env.PUBLIC_API_URL,
    PUBLIC_DASHBOARD_URL: process.env.PUBLIC_DASHBOARD_URL,
    SESSION_SECRET: process.env.SESSION_SECRET,
    SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME,
    REVALIDATE_SIGNING_SECRET: process.env.REVALIDATE_SIGNING_SECRET,
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid storefront environment — ${problems}`);
  }

  cached = parsed.data;
  return cached;
}
