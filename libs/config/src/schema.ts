import { z } from "zod";

/**
 * The complete environment contract for apps/api and apps/worker.
 *
 * Every variable the server processes read is declared HERE and nowhere else.
 * The rule this enforces (spec rule 4) is that the API can never boot in a
 * half-configured state: validation runs before `listen()`, and a missing
 * DATABASE_URL is a startup crash with a clear message rather than a 500 on the
 * first request that happens to touch the database.
 *
 * This replaces the old lazy pattern in the storefront's wp clients, which read
 * `process.env` inline and threw per-request.
 */

/** Comma-separated list -> string[]. Used for CORS origins. */
const csvList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.string().url()).min(1));

/** "15m" / "30d" / "3600s" — a duration string the JWT signer understands. */
const durationString = z
  .string()
  .regex(/^\d+[smhd]$/, 'Duration must look like "15m", "24h" or "30d"');

/**
 * Secrets carry a minimum length. A 32-byte HS512 signing key is the floor at
 * which the signature is worth anything; accepting "secret" in production is
 * how a forged admin token happens.
 */
const secret = (name: string) =>
  z.string().min(32, `${name} must be at least 32 characters of high-entropy random data`);

export const nodeEnvSchema = z.enum(["development", "test", "production"]);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

/**
 * The two Wompi environments and everything that is DERIVED from the choice.
 *
 * DERIVED, NOT CONFIGURED. There is no `WOMPI_BASE_URL`: a free-form URL beside
 * an environment flag is two values that must agree, and the way they disagree
 * is real credentials pointed at a fake processor (or the reverse). The key
 * PREFIXES are part of the same table, so a sandbox key pasted into a live
 * deployment is a boot failure naming the variable — Wompi issues `pub_test_…`
 * / `prv_test_…` / `test_integrity_…` / `test_events_…` in sandbox and the
 * `prod` equivalents in production (docs.wompi.co, "Ambientes y llaves").
 */
export const WOMPI_ENVIRONMENTS = {
  sandbox: {
    apiBaseUrl: "https://sandbox.wompi.co/v1",
    checkoutUrl: "https://checkout.wompi.co/p/",
    /** `environment` as Wompi stamps it on an event body. */
    eventEnvironment: "test",
    prefixes: {
      WOMPI_PUBLIC_KEY: "pub_test_",
      WOMPI_PRIVATE_KEY: "prv_test_",
      WOMPI_INTEGRITY_SECRET: "test_integrity_",
      WOMPI_EVENTS_SECRET: "test_events_",
    },
  },
  live: {
    apiBaseUrl: "https://production.wompi.co/v1",
    checkoutUrl: "https://checkout.wompi.co/p/",
    eventEnvironment: "prod",
    prefixes: {
      WOMPI_PUBLIC_KEY: "pub_prod_",
      WOMPI_PRIVATE_KEY: "prv_prod_",
      WOMPI_INTEGRITY_SECRET: "prod_integrity_",
      WOMPI_EVENTS_SECRET: "prod_events_",
    },
  },
} as const;

export type WompiEnvironment = keyof typeof WOMPI_ENVIRONMENTS;

type WompiKeyName = keyof (typeof WOMPI_ENVIRONMENTS)["live"]["prefixes"];

const WOMPI_KEY_NAMES: readonly WompiKeyName[] = [
  "WOMPI_PUBLIC_KEY",
  "WOMPI_PRIVATE_KEY",
  "WOMPI_INTEGRITY_SECRET",
  "WOMPI_EVENTS_SECRET",
];

/**
 * Which environment applies.
 *
 * NEVER A SILENT LIVE DEFAULT. Unset resolves to sandbox, and production
 * refuses unset outright (see the refinement). The deployed API may run
 * `NODE_ENV=development`, so a `NODE_ENV`-derived default would resolve the LIVE
 * deployment to sandbox — real customers on a sandbox checkout — and a
 * production-derived "live" default would charge cards from a build nobody
 * deliberately pointed at money. The deployment pins `WOMPI_ENVIRONMENT`.
 *
 * ONE FUNCTION, used by both the refinement and the transform, so the
 * environment that was validated is the one that is handed out.
 */
function resolveWompiEnvironment(explicit: WompiEnvironment | undefined): WompiEnvironment {
  return explicit ?? "sandbox";
}

/** Blank is absent: `.env.example` ships `WOMPI_PUBLIC_KEY=` style lines. */
const optionalKey = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value.length === 0 ? undefined : value));

/**
 * The declared variables, before refinement or resolution.
 *
 * EXPORTED so `.env.example`'s cross-check can read the key list without
 * unwrapping effects. `serverEnvSchema` is a `ZodEffects` around this — two of
 * them now, a refinement and a transform — and `.innerType().innerType()` is a
 * chain that silently breaks the moment another is added.
 */
export const serverEnvShape = z
  .object({
    NODE_ENV: nodeEnvSchema.default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3333),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    // --- Database ----------------------------------------------------------
    DATABASE_URL: z.string().url().startsWith("postgres"),
    /** Unpooled connection. Migrations must not run through PgBouncer. */
    DIRECT_DATABASE_URL: z.string().url().startsWith("postgres"),

    // --- Auth --------------------------------------------------------------
    JWT_ACCESS_SECRET: secret("JWT_ACCESS_SECRET"),
    JWT_ACCESS_TTL: durationString.default("15m"),
    REFRESH_TOKEN_TTL: durationString.default("30d"),
    /**
     * argon2id parameters. Defaults are the OWASP-recommended floor
     * (19 MiB, t=2). Lowering them below this in production silently weakens
     * every stored password, so the schema enforces the minimum.
     */
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(19_456).default(19_456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).default(2),

    // --- Wompi -------------------------------------------------------------
    //
    // The former `WHOP_*` block is DELETED, not commented out, in the same
    // change that removed the Whop adapter. Required variables for an adapter
    // that no longer exists are a secret every deployment keeps rotating for
    // nothing.
    /**
     * Which Wompi environment the keys below belong to: "sandbox" or "live".
     *
     * PINNED EXPLICITLY ON EVERY DEPLOYMENT. Unset means sandbox, and production
     * refuses unset — see `resolveWompiEnvironment` for why neither direction
     * may be inferred from `NODE_ENV`.
     */
    WOMPI_ENVIRONMENT: z.enum(["sandbox", "live"]).optional(),
    /** `pub_test_…` / `pub_prod_…`. Public: it is a query parameter on the checkout URL. */
    WOMPI_PUBLIC_KEY: optionalKey,
    /** `prv_test_…` / `prv_prod_…`. Bearer for `GET /v1/transactions/{id}`. */
    WOMPI_PRIVATE_KEY: optionalKey,
    /**
     * `test_integrity_…` / `prod_integrity_…`. Signs the checkout URL:
     * `sha256(reference + amountInCents + currency + expirationTime + secret)`.
     * Without it a buyer could edit `amount-in-cents` in the URL.
     */
    WOMPI_INTEGRITY_SECRET: optionalKey,
    /**
     * `test_events_…` / `prod_events_…`. The ENTIRE security boundary on
     * `POST /v1/webhooks/wompi`: without it anyone could post an APPROVED
     * transaction and mark an order paid.
     */
    WOMPI_EVENTS_SECRET: optionalKey,
    /**
     * Whether a real payment provider is engaged at checkout.
     *
     * "false" is DEMO MODE: checkout skips Wompi entirely, settles the order
     * locally as PAID and returns the customer to the ordinary processing screen.
     * It exists so the whole shop can be shown working before any payment
     * credentials exist. With it "true" all four `WOMPI_*` keys are required.
     *
     * PRODUCTION REFUSES IT (see the guard below). A deployment that marked
     * orders paid without charging anyone would be fraud.
     *
     * `z.coerce.boolean()` is deliberately NOT used: it is JavaScript
     * truthiness, so the string "false" coerces to `true` and the flag would do
     * the exact opposite of what the operator wrote.
     */
    PAYMENTS_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),

    // --- Email -------------------------------------------------------------
    /**
     * Which transport `EmailModule` binds.
     *
     * "smtp" IS A MISNOMER: there is no SMTP adapter. apps/api's
     * `modules/email/adapters` holds exactly three transports — in-memory,
     * logging and resend — and the factory binds Resend for "resend" and
     * `LoggingTransport` for everything else. So this variable has exactly two
     * settings: DELIVER, or DISCARD WHILE REPORTING SUCCESS.
     *
     * The name survives because the deployment already has it set and a
     * schema that rejected the value would take the API down at boot, which is
     * the failure this whole guard exists to avoid causing. It is documented
     * honestly in `.env.example` instead, and the credential rule in the
     * refinement below is what actually makes the discard impossible to reach
     * once mail can be sent at all.
     */
    EMAIL_TRANSPORT: z.enum(["resend", "smtp"]).default("smtp"),
    /**
     * The Resend API key — the ONLY channel by which mail leaves this system.
     *
     * Optional, because a deployment that has not been issued one yet must
     * still boot. But its PRESENCE is a statement of intent, and the refinement
     * below reads it as one: a process holding this key while `EMAIL_TRANSPORT`
     * says anything but "resend" refuses to start.
     */
    RESEND_API_KEY: z.string().trim().optional(),
    /**
     * Svix signing secret for the Resend webhook (`whsec_…`).
     *
     * OPTIONAL rather than required-with-resend, deliberately: sending mail and
     * receiving delivery events are separately useful, and a deployment that has
     * not registered an endpoint yet should still be able to send. The webhook
     * route refuses every delivery with 503 while this is unset, and the admin
     * email log marks rows "awaiting provider", so the missing half is visible
     * rather than silent.
     *
     * Without it, `email_event.status` never advances past SENT — DELIVERED,
     * BOUNCED and COMPLAINED are only ever reported out of band by the provider.
     */
    RESEND_WEBHOOK_SECRET: z.string().min(32).optional(),
    EMAIL_FROM: z.string().email(),
    /**
     * Where a contact-form submission is DELIVERED — deliberately separate from
     * `EMAIL_FROM`, which is the "From" address on every transactional email the
     * system sends (order confirmations, password resets, this notification
     * included). Before this existed, `ContactService` sent the operations
     * notification `to: EMAIL_FROM`, which meant a support inbox could only be
     * changed by also changing the From address on every other email the store
     * sends — and pointing that shared value at a free mailbox (a `gmail.com`
     * address, say) would route password resets through it too, with no SPF/DKIM
     * alignment for that domain.
     *
     * OPTIONAL, falling back to `EMAIL_FROM` in `ContactService` when unset, so a
     * deployment that has not configured this yet keeps today's exact behaviour.
     */
    CONTACT_INBOX_EMAIL: z.string().email().optional(),
    /**
     * VESTIGIAL. Nothing reads it: the only references outside this file are
     * `.env.example`, docker-compose and test fixtures. It is still required
     * alongside `EMAIL_TRANSPORT="smtp"` so that the existing deployments and
     * fixtures which set it keep validating unchanged — dropping the rule would
     * be a gratuitous behaviour change, and dropping the variable would break
     * every `.env` copied from the example.
     */
    SMTP_URL: z.string().url().optional(),

    // --- Object storage ----------------------------------------------------
    S3_ENDPOINT: z.string().url(),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),

    // --- Origins -----------------------------------------------------------
    CORS_ALLOWED_ORIGINS: csvList,
    STOREFRONT_URL: z.string().url(),
    DASHBOARD_URL: z.string().url(),

    // --- Misc --------------------------------------------------------------
    /** Signed-header replacement for the leaky ?secret= query-string pattern. */
    REVALIDATE_SIGNING_SECRET: secret("REVALIDATE_SIGNING_SECRET"),
    /**
     * Cloudflare Turnstile secret key — the bot control on the three public
     * endpoints that create an account or send mail (`/v1/auth/register`,
     * `/v1/auth/password-reset/request`, `/v1/contact`).
     *
     * OPTIONAL, so a laptop and a not-yet-provisioned deployment still boot.
     * Its presence is what makes the control REAL: AuthModule and ContactModule
     * bind `TurnstileCaptchaVerifier` when it is set and
     * `AlwaysAllowCaptchaVerifier` — which accepts any string — when it is not.
     * The `turnstileToken` field is required by the contract either way, so
     * without this key the field looks like a control in review and verifies
     * nothing.
     *
     * `.trim()` IS LOAD-BEARING, not tidiness. `.env.example` ships a bare
     * `TURNSTILE_SECRET_KEY=` and both module factories branch on
     * `=== undefined || === ""`, so a value of `"   "` would slip past them and
     * hand a blank secret to the real verifier — Cloudflare answers
     * `invalid-input-secret` with `success:false`, and EVERY registration on the
     * site is rejected while the variable looks correctly set. Normalising here
     * means blank reads as absent everywhere, on both sides of the rule below.
     */
    TURNSTILE_SECRET_KEY: z.string().trim().optional(),
    SENTRY_DSN: z.string().url().optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  });

export const serverEnvSchema = serverEnvShape
  .superRefine((env, ctx) => {
    // Cross-field rules. These are the constraints that a per-field schema
    // cannot express but that WILL take the system down if violated.

    // `""` and `"   "` are NOT credentials. `.env.example` ships a bare
    // `RESEND_API_KEY=` and the deployment's env string was seeded from it, so
    // an empty value is the ordinary "not issued yet" state and has to read as
    // ABSENT on both sides of the two rules below.
    const resendCredential = env.RESEND_API_KEY?.trim() ?? "";

    if (env.EMAIL_TRANSPORT === "resend" && resendCredential.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RESEND_API_KEY"],
        message: 'RESEND_API_KEY is required when EMAIL_TRANSPORT is "resend"',
      });
    }

    /**
     * The reverse, and the one that actually bites: a sending credential in the
     * environment while the transport throws mail away.
     *
     * THE SIGNAL IS THE CREDENTIAL, NOT `NODE_ENV`. The production block below
     * already refuses a non-resend transport and it NEVER FIRES on this
     * platform, because the deployed API deliberately runs
     * `NODE_ENV=development` — the identical trap `WOMPI_ENVIRONMENT` exists to
     * escape. Under that default every order confirmation is handed to
     * `LoggingTransport`, which returns a fabricated `local-000001` message id
     * and delivers nothing: green logs, an email log full of SENT rows, and no
     * customer ever receiving anything. There is no SMTP adapter in
     * apps/api/src/modules/email/adapters at all, so "not resend" means
     * "discarded", full stop.
     *
     * Keyed on the credential it cannot take the running deployment down, which
     * is the other half of the problem: that API holds no Resend key yet, so
     * this rule is inert until one is issued — and the moment one is, using it
     * stops being optional. Resend is the only way mail can leave this system,
     * so a process holding a sending credential while binding the discard
     * transport is a misconfiguration in every environment, with no case worth
     * carving out.
     *
     * It is deliberately NOT keyed on `PAYMENTS_ENABLED` or the resolved Wompi
     * environment either: both are already `true`/`live` on the deployment, so
     * either would refuse the very boot this rule must never refuse.
     */
    if (resendCredential.length > 0 && env.EMAIL_TRANSPORT !== "resend") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["EMAIL_TRANSPORT"],
        message:
          `RESEND_API_KEY is set, so EMAIL_TRANSPORT must be "resend" — it is ` +
          `"${env.EMAIL_TRANSPORT}", which binds the logging transport: it reports a ` +
          `fabricated message id and delivers nothing, so no customer would receive an ` +
          `order confirmation. Set EMAIL_TRANSPORT=resend in the SAME edit that supplies ` +
          `the key, or remove the key.`,
      });
    }

    /**
     * NO OPEN MAIL RELAY: mail that can actually be sent requires a real captcha.
     *
     * `POST /v1/auth/register` takes an attacker-chosen address, creates a
     * `customer` row and publishes `auth.customer.registered`, i.e. one
     * verification email to an address the requester picked. Its only bot
     * control is `turnstileToken`, and that token is only VERIFIED when this key
     * is set — otherwise both module factories bind
     * `AlwaysAllowCaptchaVerifier`, which returns true for any string.
     * `/v1/auth/password-reset/request` and `/v1/contact` are the same shape.
     *
     * THE SIGNAL IS THE SENDING CREDENTIAL, NOT `NODE_ENV`, and for the third
     * time in this file that distinction is the whole point. The production
     * block below already demands this key and NEVER FIRES on this platform,
     * because the deployed API deliberately runs `NODE_ENV=development` — the
     * identical trap `WOMPI_ENVIRONMENT` exists to escape and the
     * `EMAIL_TRANSPORT` rule above was just fixed for.
     *
     * `RESEND_API_KEY` is the right signal because it is the precise condition
     * under which the endpoint becomes a relay rather than merely noisy.
     * Resend is the only channel by which mail leaves this system; with no key,
     * `LoggingTransport` fabricates a message id and delivers nothing, so an
     * abuser gets `customer` rows and no outbound mail. The moment a key is
     * issued — against a verified `akai.shop` sending domain — the same
     * request becomes one delivered email per attempt from our own domain, and
     * the cost of leaving it open is the domain's sending reputation. So the
     * guard fires at boot, in the SAME edit that provisions Resend, rather than
     * being a control someone has to remember to turn on afterwards.
     *
     * Keyed this way it cannot take the running deployment down, which is the
     * other half of the requirement: that API holds no Resend key, so the rule
     * is inert until one is issued. It is deliberately NOT keyed on an https
     * `CORS_ALLOWED_ORIGINS`, on live Wompi, or on `PAYMENTS_ENABLED` — the
     * deployment already has all three, so any of them would refuse the very
     * boot this rule must never refuse.
     *
     * THERE IS NO ESCAPE HATCH, unlike `PAYMENTS_ENABLED=false`. That flag exists so a
     * contributor with no Wompi account can boot; nobody needs to hold a live
     * sending credential AND leave the account-creating endpoints unguarded, so
     * there is no case worth carving out. A dev machine has neither key and is
     * unaffected.
     */
    if (resendCredential.length > 0 && (env.TURNSTILE_SECRET_KEY ?? "").length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURNSTILE_SECRET_KEY"],
        message:
          `RESEND_API_KEY is set, so mail can now actually be delivered — ` +
          `TURNSTILE_SECRET_KEY is required in the SAME edit.\n\n` +
          `DO THIS FIRST, IN THIS ORDER, or you will take sign-in down:\n` +
          `  1. Set NEXT_PUBLIC_TURNSTILE_SITE_KEY and REBUILD BOTH Next ` +
          `images (storefront AND dashboard). That variable is inlined by Next ` +
          `at BUILD time, so saving it in the deployment and restarting does ` +
          `NOT apply it — the running images keep sending the literal ` +
          `"turnstile-not-configured".\n` +
          `  2. Only then set TURNSTILE_SECRET_KEY here.\n` +
          `Do it the other way round and this API starts verifying a token the ` +
          `frontends cannot produce, so EVERY register, resend-verification ` +
          `and password-reset returns "Bot verification failed" until the ` +
          `rebuild lands — with a clean boot and no warning.\n\n` +
          `WHY THE RULE EXISTS: without the secret the verifier is ` +
          `AlwaysAllowCaptchaVerifier, which accepts any token string, and ` +
          `POST /v1/auth/register becomes an open relay — one verification ` +
          `email from the verified sending domain to any address an attacker ` +
          `names, plus a customer row per attempt.`,
      });
    }

    // A KEY, NOT A PLACEHOLDER. The rule above is satisfied by any non-blank
    // string, so "changeme" or a half-pasted value would report a clean boot
    // while leaving every guarded endpoint exactly as open as no secret at all.
    //
    // WHAT THIS CANNOT DO is tell a secret key from a site key: Cloudflare
    // issues both as `0x…`, so the shapes are identical and only Cloudflare can
    // reject the wrong one (it will, on every siteverify call). The prefix set
    // below is deliberately wide — `0x` is production, and `1x`/`2x`/`3x` are
    // Cloudflare's documented ALWAYS-PASS / ALWAYS-FAIL / FORCE-CHALLENGE test
    // keys, which local development and CI are supposed to use. A stricter
    // check would refuse exactly the values the docs tell you to develop with.
    const turnstileSecret = (env.TURNSTILE_SECRET_KEY ?? "").trim();
    if (turnstileSecret.length > 0 && !/^[0-3]x/.test(turnstileSecret)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURNSTILE_SECRET_KEY"],
        message:
          `TURNSTILE_SECRET_KEY does not look like a Cloudflare key. Real ` +
          `ones begin "0x"; the documented test keys begin "1x", "2x" or ` +
          `"3x". A placeholder here reports a clean boot while leaving ` +
          `register, resend-verification and password-reset exactly as open ` +
          `as no secret at all. NOTE: this cannot tell a secret key from a ` +
          `site key — both are "0x…" — so check you pasted the SECRET half; ` +
          `the site key is public and belongs in ` +
          `NEXT_PUBLIC_TURNSTILE_SITE_KEY.`,
      });
    }

    if (env.EMAIL_TRANSPORT === "smtp" && !env.SMTP_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SMTP_URL"],
        message: 'SMTP_URL is required when EMAIL_TRANSPORT is "smtp"',
      });
    }

    if (env.NODE_ENV === "production") {
      if (!env.PAYMENTS_ENABLED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PAYMENTS_ENABLED"],
          message:
            'PAYMENTS_ENABLED cannot be "false" in production: checkout would mark orders PAID without taking any money',
        });
      }

      if (env.EMAIL_TRANSPORT !== "resend") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["EMAIL_TRANSPORT"],
          message:
            'Production must use EMAIL_TRANSPORT="resend"; there is no SMTP adapter at all, so any other value binds LoggingTransport, which fabricates a message id and discards the mail — no customer would ever receive an order confirmation',
        });
      }

      if (!env.TURNSTILE_SECRET_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TURNSTILE_SECRET_KEY"],
          message:
            "TURNSTILE_SECRET_KEY is required in production; register and contact endpoints are otherwise unprotected against bots. NOTE: this branch is inert on a deployment running NODE_ENV=development — the RESEND_API_KEY-keyed rule above is the one that actually holds.",
        });
      }

      for (const origin of env.CORS_ALLOWED_ORIGINS) {
        if (origin.startsWith("http://")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["CORS_ALLOWED_ORIGINS"],
            message: `Refusing a plaintext origin in production: ${origin}. Session cookies are Secure and would never be sent.`,
          });
        }
      }
    }

    // --- Wompi environment and keys ------------------------------------
    if (env.NODE_ENV === "production") {
      if (env.WOMPI_ENVIRONMENT === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["WOMPI_ENVIRONMENT"],
          message:
            'WOMPI_ENVIRONMENT must be set explicitly in production ("live"); it is never inferred',
        });
      } else if (env.WOMPI_ENVIRONMENT === "sandbox") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["WOMPI_ENVIRONMENT"],
          message:
            'WOMPI_ENVIRONMENT cannot be "sandbox" in production: checkout would hand real customers a sandbox payment page and mark their orders PAID without taking any money',
        });
      }
    }

    const wompiEnvironment = resolveWompiEnvironment(env.WOMPI_ENVIRONMENT);
    const prefixes = WOMPI_ENVIRONMENTS[wompiEnvironment].prefixes;

    for (const name of WOMPI_KEY_NAMES) {
      const value = env[name];

      // ONLY WHEN PAYMENTS ARE ENGAGED. With `PAYMENTS_ENABLED=false` checkout
      // settles in-process and never reaches Wompi, so a fresh clone must boot
      // without an account. Named individually: a boot failure should say which
      // variable to go and fetch.
      if (value === undefined) {
        if (env.PAYMENTS_ENABLED) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} is required when PAYMENTS_ENABLED is "true" (Wompi dashboard -> Desarrolladores; ${wompiEnvironment} keys start with "${prefixes[name]}")`,
          });
        }
        continue;
      }

      // A key from the OTHER environment is the misconfiguration that matters:
      // it fails at Wompi with a 401 (or, for the events secret, rejects every
      // genuine webhook) long after a green deploy. The value is never echoed.
      if (!value.startsWith(prefixes[name])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} does not belong to the "${wompiEnvironment}" Wompi environment: it must start with "${prefixes[name]}". Check WOMPI_ENVIRONMENT and that the key came from the matching Wompi account.`,
        });
      }
    }
  })
  /**
   * Resolve the ACTIVE Wompi configuration once, at boot.
   *
   * `null` WHEN ANY KEY IS ABSENT — which the refinement allows only with
   * `PAYMENTS_ENABLED=false`. Null rather than empty strings on purpose: an
   * empty events secret makes `sha256(manifest + "")` a checksum ANYONE can
   * compute, so the webhook route must be able to see "not configured" and
   * refuse, not verify against nothing.
   */
  .transform((env) => {
    const environment = resolveWompiEnvironment(env.WOMPI_ENVIRONMENT);
    const derived = WOMPI_ENVIRONMENTS[environment];

    const {
      WOMPI_PUBLIC_KEY: publicKey,
      WOMPI_PRIVATE_KEY: privateKey,
      WOMPI_INTEGRITY_SECRET: integritySecret,
      WOMPI_EVENTS_SECRET: eventsSecret,
    } = env;

    const wompi: WompiConfig | null =
      publicKey === undefined ||
      privateKey === undefined ||
      integritySecret === undefined ||
      eventsSecret === undefined
        ? null
        : {
            environment,
            publicKey,
            privateKey,
            integritySecret,
            eventsSecret,
            apiBaseUrl: derived.apiBaseUrl,
            checkoutUrl: derived.checkoutUrl,
            eventEnvironment: derived.eventEnvironment,
          };

    return { ...env, WOMPI_ENVIRONMENT: environment, wompi };
  });

/** The resolved Wompi configuration every consumer reads (`config.wompi`). */
export interface WompiConfig {
  readonly environment: WompiEnvironment;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly integritySecret: string;
  readonly eventsSecret: string;
  /** `https://sandbox.wompi.co/v1` or `https://production.wompi.co/v1`. */
  readonly apiBaseUrl: string;
  /** Web Checkout: `https://checkout.wompi.co/p/` in both environments. */
  readonly checkoutUrl: string;
  /** `"test"` or `"prod"` — what Wompi writes in an event's `environment`. */
  readonly eventEnvironment: string;
}

export type ServerEnv = z.infer<typeof serverEnvSchema>;
