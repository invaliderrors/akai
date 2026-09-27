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

/**
 * Sendcloud's v3 API. There is no sandbox host (spec §1 S5) — "test" is a mode
 * of the SAME account (`SENDCLOUD_MODE`), so the URL is a constant, not config.
 */
export const SENDCLOUD_BASE_URL = "https://panel.sendcloud.sc/api/v3";

/** `config.sendcloud` — the resolved, complete Sendcloud configuration. */
export interface SendcloudConfig {
  readonly publicKey: string;
  readonly secretKey: string;
  /** The panel's Webhook Signature Key, or the secret key when none is set. */
  readonly webhookSecret: string;
  readonly senderAddressId: number;
  readonly mode: "test" | "live";
  readonly baseUrl: string;
}

/** `""` / whitespace → `undefined`. A blank variable is ABSENT, never a credential. */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

export const nodeEnvSchema = z.enum(["development", "test", "production"]);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

/**
 * The two Whop environments, and the only two base URLs that exist.
 *
 * DERIVED, NOT CONFIGURED. This was a free-form `WHOP_BASE_URL` and is now a
 * consequence of `WHOP_ENVIRONMENT`, because the pair must never disagree: a
 * live key against the sandbox host returns 401, and a sandbox key against the
 * live host does too. Two variables that must agree is a way to point real
 * credentials at a fake processor by editing one of them.
 */
const WHOP_BASE_URLS = {
  live: "https://api.whop.com/api/v1",
  sandbox: "https://sandbox-api.whop.com/api/v1",
} as const;

export type WhopEnvironment = keyof typeof WHOP_BASE_URLS;

/**
 * Which environment applies, from the explicit override or `NODE_ENV`.
 *
 * ONE FUNCTION, used by both the refinement and the transform below. They have
 * to agree — a refinement that validates the sandbox set while the transform
 * hands out the live one is a config that passes boot and charges real cards.
 */
function resolveWhopEnvironment(
  explicit: WhopEnvironment | undefined,
  nodeEnv: string,
): WhopEnvironment {
  if (explicit !== undefined) {
    return explicit;
  }
  return nodeEnv === "production" ? "live" : "sandbox";
}

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

    // --- Whop ---------------------------------------------------------------
    //
    // The former `TAGADA_*` block is DELETED, not commented out, and it is deleted
    // in the same change that removed `apps/api/src/modules/payments/tagada/**`.
    // Keeping required variables for an adapter that no longer exists means
    // every deployment must keep supplying a TagadaPay secret to boot a system
    // that cannot reach TagadaPay — an operator would reasonably conclude the
    // key is live and rotate it on a schedule, forever.
    /**
     * Whop LIVE API key — the unprefixed `WHOP_*` set is the production one.
     *
     * NO PREFIX CHECK: Whop issues several credential types and the docs do not
     * commit to a single stable prefix for server keys, so asserting one would
     * reject a key the API honours. Length is the only shape assertion that is
     * safe to make here — which is also why a sandbox key pasted here would be
     * accepted, and why `WHOP_ENVIRONMENT` decides which set is used rather than
     * anything inferred from the value.
     */
    WHOP_API_KEY: z.string().min(20),
    /** `biz_…`. The account every checkout configuration is created under. */
    WHOP_ACCOUNT_ID: z.string().startsWith("biz_"),
    /**
     * `prod_…`. The SINGLE Whop product every per-order plan hangs off.
     *
     * There is no catalog mirror. Whop takes our computed amount directly on
     * the checkout call, so a product exists here only because a plan must
     * belong to one — it is a container, not a representation of anything we
     * sell.
     */
    WHOP_PRODUCT_ID: z.string().startsWith("prod_"),
    /**
     * The webhook endpoint signing secret, copied from the Whop dashboard
     * (Developer -> Webhooks).
     *
     * `ws_` PREFIX IS REQUIRED, AND THE PREFIX IS PART OF THE KEY. Whop HMACs
     * with the literal bytes of the secret it issued, prefix included, so a
     * secret stored with `ws_` stripped derives a DIFFERENT key and every
     * delivery fails verification. Asserting the prefix here turns that into a
     * boot failure naming the variable, instead of a silent 100% webhook
     * rejection rate discovered when orders stop settling.
     *
     * This secret is the entire security boundary on the webhook route: without
     * it, anyone on the internet could POST `payment.succeeded` and mark any
     * order paid. Hence the 32-char floor `secret()` applies.
     */
    WHOP_WEBHOOK_SECRET: secret("WHOP_WEBHOOK_SECRET").startsWith("ws_"),
    /**
     * Which Whop environment the credentials above are used against.
     *
     * DEFAULTS FROM `NODE_ENV` — development means sandbox, production means
     * live — so a developer gets test cards without configuring anything, and a
     * production build cannot quietly point at a fake processor.
     *
     * IT IS OVERRIDABLE, AND ON THIS PLATFORM THAT IS LOAD-BEARING RATHER THAN A
     * CONVENIENCE. The deployed API deliberately runs `NODE_ENV=development`,
     * because the guard below refuses `PAYMENTS_ENABLED=false` in production and
     * this deployment ran credential-free for a while. A pure `NODE_ENV` rule
     * would therefore resolve the LIVE deployment to sandbox, and the moment
     * payments were enabled real customers would be handed a sandbox checkout
     * and their orders marked PAID having taken no money — the same fraud the
     * `PAYMENTS_ENABLED` guard exists to prevent, arriving through another door.
     * So the deployment pins `WHOP_ENVIRONMENT=live` explicitly and the default
     * only governs a developer's laptop.
     *
     * The refinement below still refuses sandbox under `NODE_ENV=production`
     * outright: an override may correct the default, never invert the one case
     * where the answer is not a judgement call.
     */
    WHOP_ENVIRONMENT: z.enum(["sandbox", "live"]).optional(),

    // --- Sandbox credentials ------------------------------------------------
    //
    // A WHOLLY SEPARATE ACCOUNT, not a mode flag. Whop's sandbox lives at
    // sandbox.whop.com with its own dashboard, its own `biz_`/`prod_` ids and
    // its own keys; a live key returns 401 against `sandbox-api.whop.com` and
    // vice versa. That is why these are four more variables rather than one
    // boolean — there is no shared credential to reuse.
    //
    // ALL OPTIONAL, and required only when sandbox is the resolved environment
    // (see the refinement). A live-only deployment sets none of them.
    WHOP_SANDBOX_API_KEY: z.string().min(20).optional(),
    WHOP_SANDBOX_ACCOUNT_ID: z.string().startsWith("biz_").optional(),
    WHOP_SANDBOX_PRODUCT_ID: z.string().startsWith("prod_").optional(),
    WHOP_SANDBOX_WEBHOOK_SECRET: secret("WHOP_SANDBOX_WEBHOOK_SECRET")
      .startsWith("ws_")
      .optional(),
    /**
     * The dated API version every request is pinned to.
     *
     * REQUIRED, NOT DEFAULTED. Whop versions its payload shapes by date, and
     * the webhook body our settlement check reads (`PaymentLegacy`) is one of
     * them. A default here would mean the pin silently moves whenever this file
     * is edited; an explicit value per environment means upgrading is a
     * deliberate act with a diff.
     */
    WHOP_API_VERSION_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
      message: "WHOP_API_VERSION_DATE must be a YYYY-MM-DD Whop API version date",
    }),
    /**
     * Whether a real payment provider is engaged at checkout.
     *
     * "false" is DEMO MODE: checkout skips Whop entirely, settles the order
     * locally as PAID and returns the customer to the ordinary processing screen.
     * It exists so the whole shop — catalogue, cart, orders, confirmation emails,
     * invoices, returns, metrics — can be shown working before any payment
     * credentials exist.
     *
     * PRODUCTION REFUSES IT (see the guard below). A deployment that took real
     * card details and marked orders paid without charging anyone would be
     * fraud, so the flag cannot reach one — the same containment
     * `WHOP_BOOT_CHECK` uses.
     *
     * `z.coerce.boolean()` is deliberately NOT used: it is JavaScript
     * truthiness, so the string "false" coerces to `true` and the flag would do
     * the exact opposite of what the operator wrote.
     */
    PAYMENTS_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),

    /**
     * Whether `LiveWhopGateway.onModuleInit` proves the credentials are real
     * before the API serves traffic.
     *
     * DEFAULTS ON, and the production guard below REFUSES to let it be turned
     * off. It exists solely so the stack can be booted locally without a Whop
     * account — without it, `pnpm start:api` is impossible for anyone who has
     * not been issued credentials, which is every new contributor and every CI
     * job.
     *
     * `z.coerce.boolean()` is deliberately NOT used, for the same reason as
     * PAYMENTS_ENABLED above.
     */
    WHOP_BOOT_CHECK: z
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
    /**
     * A SEPARATE, PRIVATE bucket for certificates of analysis — never
     * `S3_BUCKET`. That bucket has an anonymous-download policy (product
     * photos are meant to be public), so a COA PDF placed there would be
     * exactly as public as a product photo no matter how its object key was
     * signed: MinIO's bucket-wide policy never checks for a signature once
     * anonymous downloads are allowed at all. `BatchesModule` writes here with
     * a signed PUT; `product.mapper.ts` reads from here with a signed GET —
     * the only two operations this bucket ever needs to authorise.
     */
    S3_BUCKET_COA: z.string().min(1),

    // --- Translation -------------------------------------------------------
    /**
     * DeepL auth key for the admin product form's ES <-> EN copy translation.
     *
     * OPTIONAL, and the feature is ABSENT rather than broken when it is unset:
     * TranslationModule binds a gateway that answers every call with
     * NOT_CONFIGURED, so the endpoint returns a typed refusal the dashboard can
     * branch on instead of a 500. No environment's boot depends on a vendor key
     * for a convenience feature, and a contributor without a DeepL account can
     * still run the whole API.
     *
     * There is deliberately NO companion DEEPL_BASE_URL. DeepL's free tier
     * lives on api-free.deepl.com and its paid tier on api.deepl.com, and a
     * FREE key is the one ending in ":fx" — so the host is DERIVED from the key
     * (`deeplBaseUrl`, apps/api/src/modules/translation). A second variable
     * could only ever disagree with the first, and the disagreement surfaces as
     * a 403 that reads exactly like a revoked credential, so an operator would
     * rotate a perfectly good key trying to fix a wrong hostname.
     */
    DEEPL_API_KEY: z.string().optional(),

    // --- Fulfilment (Sendcloud) ---------------------------------------------
    /**
     * Sendcloud v3 API credentials (HTTP Basic, public key : secret key) and the
     * sender address labels are bought from. Spec
     * `docs/superpowers/specs/2026-09-24-sendcloud-shipping.md` §3.8.
     *
     * OPTIONAL AS A SET, the DeepL precedent: with none of the three set,
     * `config.sendcloud` is `null` and the fulfilment module binds
     * `NotConfiguredSendcloudClient`, so label actions answer a coded
     * FULFILMENT_NOT_CONFIGURED, pickup-point search answers UNAVAILABLE and a
     * SERVICE_POINT rate cannot be checked out — visibly absent, never a 500.
     * PARTIALLY set is a boot failure (see the refinement below): a public key
     * without its secret is a typo, not a choice.
     *
     * `.trim()` so a bare `SENDCLOUD_PUBLIC_KEY=` copied from a template reads
     * as ABSENT rather than as a blank credential that 401s on every call.
     */
    SENDCLOUD_PUBLIC_KEY: z.string().trim().optional(),
    SENDCLOUD_SECRET_KEY: z.string().trim().optional(),
    /**
     * The panel's Webhook Signature Key. OPTIONAL even when Sendcloud is
     * configured: if the integration has no dedicated key, Sendcloud signs the
     * "parcel status changed" webhook with the integration SECRET key (spec
     * §11a), so `config.sendcloud.webhookSecret` falls back to it.
     */
    SENDCLOUD_WEBHOOK_SECRET: z.string().trim().optional(),
    /**
     * `from_address.sender_address_id` on every announced shipment — the id of
     * the warehouse address in the Sendcloud panel (`GET /addresses/sender-addresses`).
     * Blank reads as absent (preprocessed) so it joins the all-or-none rule
     * rather than failing as "not a number".
     */
    SENDCLOUD_SENDER_ADDRESS_ID: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.coerce.number().int().positive().optional(),
    ),
    /**
     * `test` (the DEFAULT) swaps every label's shipping option for
     * `sendcloud:letter` — an unstamped letter that costs (next to) nothing —
     * so no development or staging machine ever buys a real carrier label.
     * `live` buys the mapped carrier's label. Mirrors WHOP_ENVIRONMENT: the live
     * deployment pins `SENDCLOUD_MODE=live` EXPLICITLY, and it is keyed on
     * nothing else (the deployed API runs NODE_ENV=development on purpose, so a
     * NODE_ENV-derived default would be wrong in exactly the place it matters).
     */
    SENDCLOUD_MODE: z.enum(["test", "live"]).default("test"),

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
     * `NODE_ENV=development` — the identical trap `WHOP_ENVIRONMENT` exists to
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
     * It is deliberately NOT keyed on `PAYMENTS_ENABLED` or the resolved Whop
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
     * identical trap `WHOP_ENVIRONMENT` exists to escape and the
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
     * `CORS_ALLOWED_ORIGINS`, on live Whop, or on `PAYMENTS_ENABLED` — the
     * deployment already has all three, so any of them would refuse the very
     * boot this rule must never refuse.
     *
     * THERE IS NO ESCAPE HATCH, unlike `WHOP_BOOT_CHECK`. That flag exists so a
     * contributor with no Whop account can boot; nobody needs to hold a live
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

      // The boot check is the only thing that proves the Whop credentials are
      // real before a customer reaches checkout. Disabling it in production
      // moves that discovery to the first payment, which is precisely the
      // failure the check exists to prevent.
      if (!env.WHOP_BOOT_CHECK) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["WHOP_BOOT_CHECK"],
          message:
            'WHOP_BOOT_CHECK cannot be "false" in production: it is the only check that proves the Whop credentials are real before the first customer checkout',
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

    // --- Sendcloud: all or none ------------------------------------------
    // Named individually, like the Whop sandbox set: a boot failure should say
    // which variable to go and fetch. The webhook secret is NOT part of the set
    // (it falls back to the secret key), and neither is SENDCLOUD_MODE (it has
    // a safe default).
    const sendcloudSet = {
      SENDCLOUD_PUBLIC_KEY: nonBlank(env.SENDCLOUD_PUBLIC_KEY),
      SENDCLOUD_SECRET_KEY: nonBlank(env.SENDCLOUD_SECRET_KEY),
      SENDCLOUD_SENDER_ADDRESS_ID: env.SENDCLOUD_SENDER_ADDRESS_ID,
    };
    const sendcloudPresent = Object.values(sendcloudSet).filter((value) => value !== undefined);
    if (sendcloudPresent.length > 0 && sendcloudPresent.length < 3) {
      for (const [name, value] of Object.entries(sendcloudSet)) {
        if (value === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} is required once any of SENDCLOUD_PUBLIC_KEY, SENDCLOUD_SECRET_KEY and SENDCLOUD_SENDER_ADDRESS_ID is set — Sendcloud is configured all-or-none. Unset all three to run without fulfilment.`,
          });
        }
      }
    }
    if (
      sendcloudPresent.length === 0 &&
      (nonBlank(env.SENDCLOUD_WEBHOOK_SECRET) !== undefined || env.SENDCLOUD_MODE === "live")
    ) {
      // A webhook secret or an explicit live pin with no credentials is a
      // half-finished provisioning, not "Sendcloud off" — refuse it loudly
      // rather than booting with fulfilment silently absent.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SENDCLOUD_PUBLIC_KEY"],
        message:
          "SENDCLOUD_WEBHOOK_SECRET or SENDCLOUD_MODE=live is set without SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY / SENDCLOUD_SENDER_ADDRESS_ID — set the credentials too, or remove both.",
      });
    }

    // --- Whop environment selection -------------------------------------
    const whopEnvironment = resolveWhopEnvironment(env.WHOP_ENVIRONMENT, env.NODE_ENV);

    if (env.NODE_ENV === "production" && whopEnvironment === "sandbox") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WHOP_ENVIRONMENT"],
        message:
          'WHOP_ENVIRONMENT cannot be "sandbox" in production: checkout would hand real customers a sandbox payment page and mark their orders PAID without taking any money',
      });
    }

    // ONLY WHEN PAYMENTS ARE ACTUALLY ENGAGED. With `PAYMENTS_ENABLED=false`
    // checkout settles in-process and never reaches Whop, so demanding a full
    // sandbox credential set would stop a fresh clone booting to look at the
    // shop — the same reason `WHOP_BOOT_CHECK` can be turned off. The moment
    // payments are switched on in a sandbox environment, the keys become
    // mandatory and their absence is a boot failure rather than a 500 at the
    // first checkout.
    if (whopEnvironment === "sandbox" && env.PAYMENTS_ENABLED) {
      // Named individually rather than as one "sandbox is incomplete": a boot
      // failure should say which variable to go and fetch.
      const sandbox = {
        WHOP_SANDBOX_API_KEY: env.WHOP_SANDBOX_API_KEY,
        WHOP_SANDBOX_ACCOUNT_ID: env.WHOP_SANDBOX_ACCOUNT_ID,
        WHOP_SANDBOX_PRODUCT_ID: env.WHOP_SANDBOX_PRODUCT_ID,
        WHOP_SANDBOX_WEBHOOK_SECRET: env.WHOP_SANDBOX_WEBHOOK_SECRET,
      };

      for (const [name, value] of Object.entries(sandbox)) {
        if (value === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} is required when the Whop environment resolves to "sandbox". Sandbox is a separate Whop account with its own credentials — create one at sandbox.whop.com, or set WHOP_ENVIRONMENT=live to use the production keys.`,
          });
        }
      }
    }
  })
  /**
   * Resolve the ACTIVE Whop credentials once, at boot.
   *
   * Consumers read `config.whop` and never choose. Leaving the choice to each
   * call site would mean the gateway, the webhook controller and the checkout
   * service each deciding which account they are talking to, and the failure
   * when one of them disagrees is a payment taken in one environment and
   * verified against another.
   */
  .transform((env) => {
    const environment = resolveWhopEnvironment(env.WHOP_ENVIRONMENT, env.NODE_ENV);

    // The refinement above guarantees these are present whenever sandbox is the
    // resolved environment, so the fallbacks are unreachable — they exist so the
    // types stay honest without a non-null assertion.
    const whop =
      environment === "sandbox"
        ? {
            environment,
            apiKey: env.WHOP_SANDBOX_API_KEY ?? "",
            accountId: env.WHOP_SANDBOX_ACCOUNT_ID ?? "",
            productId: env.WHOP_SANDBOX_PRODUCT_ID ?? "",
            webhookSecret: env.WHOP_SANDBOX_WEBHOOK_SECRET ?? "",
            baseUrl: WHOP_BASE_URLS.sandbox,
          }
        : {
            environment,
            apiKey: env.WHOP_API_KEY,
            accountId: env.WHOP_ACCOUNT_ID,
            productId: env.WHOP_PRODUCT_ID,
            webhookSecret: env.WHOP_WEBHOOK_SECRET,
            baseUrl: WHOP_BASE_URLS.live,
          };

    // Sendcloud: resolved once, like Whop. `null` = not configured; the
    // refinement above guarantees the set is complete whenever any part is.
    const publicKey = nonBlank(env.SENDCLOUD_PUBLIC_KEY);
    const secretKey = nonBlank(env.SENDCLOUD_SECRET_KEY);
    const senderAddressId = env.SENDCLOUD_SENDER_ADDRESS_ID;
    const sendcloud: SendcloudConfig | null =
      publicKey !== undefined && secretKey !== undefined && senderAddressId !== undefined
        ? {
            publicKey,
            secretKey,
            webhookSecret: nonBlank(env.SENDCLOUD_WEBHOOK_SECRET) ?? secretKey,
            senderAddressId,
            mode: env.SENDCLOUD_MODE,
            baseUrl: SENDCLOUD_BASE_URL,
          }
        : null;

    return { ...env, whop, sendcloud };
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;
