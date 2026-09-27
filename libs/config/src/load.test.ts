import { beforeEach, describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  loadServerConfig,
  parseServerEnv,
  redactedConfig,
  resetServerConfigCache,
} from "./load";

/** A minimal environment that passes validation. Tests override single keys off this. */
function validEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
    DIRECT_DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
    JWT_ACCESS_SECRET: "a".repeat(32),
    WHOP_API_KEY: "whop_test_abc123def456ghi789",
    WHOP_ACCOUNT_ID: "biz_test_1",
    WHOP_PRODUCT_ID: "prod_test_1",
    WHOP_WEBHOOK_SECRET: `ws_${"c".repeat(32)}`,
    WHOP_API_VERSION_DATE: "2026-08-14",
    // PINNED, exactly as the deployment does. Unset, NODE_ENV=development would
    // resolve to sandbox and demand a sandbox credential set.
    WHOP_ENVIRONMENT: "live",
    EMAIL_TRANSPORT: "smtp",
    SMTP_URL: "smtp://localhost:1025",
    EMAIL_FROM: "no-reply@example.com",
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "akai-media",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
    S3_BUCKET_COA: "akai-coa",
    CORS_ALLOWED_ORIGINS: "http://localhost:3000,http://localhost:3001",
    STOREFRONT_URL: "http://localhost:3000",
    DASHBOARD_URL: "http://localhost:3001",
    REVALIDATE_SIGNING_SECRET: "b".repeat(32),
    ...overrides,
  };
}

beforeEach(() => {
  resetServerConfigCache();
});

/** A complete sandbox credential set, for the environment-selection tests. */
const SANDBOX_ENV = {
  WHOP_SANDBOX_API_KEY: "whop_sandbox_abc123def456ghi789",
  WHOP_SANDBOX_ACCOUNT_ID: "biz_sandbox_1",
  WHOP_SANDBOX_PRODUCT_ID: "prod_sandbox_1",
  WHOP_SANDBOX_WEBHOOK_SECRET: `ws_${"s".repeat(32)}`,
} as const;

describe("parseServerEnv", () => {
  it("accepts a valid environment and applies defaults", () => {
    const config = parseServerEnv(validEnv());
    expect(config.PORT).toBe(3333);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.JWT_ACCESS_TTL).toBe("15m");
    expect(config.ARGON2_MEMORY_KIB).toBe(19_456);
  });

  it("coerces numeric strings, since every env var arrives as a string", () => {
    const config = parseServerEnv(validEnv({ PORT: "8080" }));
    expect(config.PORT).toBe(8080);
    expect(typeof config.PORT).toBe("number");
  });

  it("splits CORS_ALLOWED_ORIGINS into a validated array", () => {
    const config = parseServerEnv(
      validEnv({ CORS_ALLOWED_ORIGINS: "https://a.com, https://b.com " }),
    );
    expect(config.CORS_ALLOWED_ORIGINS).toEqual(["https://a.com", "https://b.com"]);
  });

  it("throws ConfigValidationError when a required var is missing", () => {
    const env = validEnv();
    delete env["DATABASE_URL"];
    expect(() => parseServerEnv(env)).toThrow(ConfigValidationError);
  });

  it("reports EVERY problem at once, not just the first", () => {
    const env = validEnv();
    delete env["DATABASE_URL"];
    delete env["WHOP_ACCOUNT_ID"];
    delete env["S3_BUCKET"];

    try {
      parseServerEnv(env);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      if (!(error instanceof ConfigValidationError)) throw error;
      const paths = error.issues.map((issue) => issue.path);
      expect(paths).toContain("DATABASE_URL");
      expect(paths).toContain("WHOP_ACCOUNT_ID");
      expect(paths).toContain("S3_BUCKET");
    }
  });

  it("names the offending variable in the message so the fix is obvious", () => {
    const env = validEnv();
    delete env["JWT_ACCESS_SECRET"];
    expect(() => parseServerEnv(env)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it("NEVER echoes the offending value — errors reach log aggregators", () => {
    const env = validEnv({ JWT_ACCESS_SECRET: "too-short-and-secret" });
    try {
      parseServerEnv(env);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(String(error)).not.toContain("too-short-and-secret");
    }
  });

  it("rejects a weak signing secret", () => {
    expect(() => parseServerEnv(validEnv({ JWT_ACCESS_SECRET: "secret" }))).toThrow(
      /at least 32 characters/,
    );
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() =>
      parseServerEnv(validEnv({ DATABASE_URL: "mysql://localhost/db" })),
    ).toThrow(ConfigValidationError);
  });

  it("rejects argon2 parameters below the OWASP floor", () => {
    expect(() => parseServerEnv(validEnv({ ARGON2_MEMORY_KIB: "1024" }))).toThrow(
      ConfigValidationError,
    );
  });
});

describe("cross-field rules", () => {
  it("requires SMTP_URL when the transport is smtp", () => {
    const env = validEnv();
    delete env["SMTP_URL"];
    expect(() => parseServerEnv(env)).toThrow(/SMTP_URL/);
  });

  it("requires RESEND_API_KEY when the transport is resend", () => {
    expect(() => parseServerEnv(validEnv({ EMAIL_TRANSPORT: "resend" }))).toThrow(
      /RESEND_API_KEY/,
    );
  });

  it("REFUSES a discarding transport once a Resend credential exists", () => {
    // THE DEFECT. There is no SMTP transport in the codebase at all — anything
    // that is not "resend" binds LoggingTransport, which returns a fabricated
    // `local-000001` message id and delivers NOTHING. The existing guard against
    // that lives inside `if (NODE_ENV === "production")`, and this deployment
    // deliberately runs NODE_ENV=development, so it never fires and every
    // "delivered" email reaches nobody with green logs.
    //
    // The signal is the CREDENTIAL, not NODE_ENV: RESEND_API_KEY is the only
    // way mail can leave this system, so holding one while binding the discard
    // transport is never anything but a mistake. Same shape as WHOP_ENVIRONMENT
    // — an explicit signal the operator states, not one inferred from NODE_ENV.
    expect(() =>
      parseServerEnv(
        validEnv({
          NODE_ENV: "development",
          EMAIL_TRANSPORT: "smtp",
          RESEND_API_KEY: "re_live_a_real_key_that_can_send_mail",
        }),
      ),
    ).toThrow(/EMAIL_TRANSPORT/);
  });

  it("STILL BOOTS the deployed shape: development, smtp, no Resend key yet", () => {
    // THE HARD CONSTRAINT, locked as a test. The deployed API runs
    // NODE_ENV=development with EMAIL_TRANSPORT=smtp and no Resend key issued;
    // a guard that refused a non-resend transport unconditionally would take
    // the live API down on its next deploy. The rule above must be keyed on
    // something this environment does not yet have.
    const env = validEnv({
      NODE_ENV: "development",
      WHOP_ENVIRONMENT: "live",
      PAYMENTS_ENABLED: "true",
      EMAIL_TRANSPORT: "smtp",
      SMTP_URL: "smtp://akai-mailpit-7urpbe:1025",
    });
    delete env["RESEND_API_KEY"];

    expect(() => parseServerEnv(env)).not.toThrow();
  });

  it("treats a bare RESEND_API_KEY= as no credential rather than a broken one", () => {
    // `.env.example` ships `RESEND_API_KEY=` with an empty value, and the
    // deployment's env string was seeded from it. If empty counted as "a
    // credential exists" the rule above would fail the boot it is forbidden to
    // fail, and if it counted as a usable key the module factory would throw at
    // DI time instead. Empty means absent, and absent is the status quo.
    expect(() =>
      parseServerEnv(validEnv({ EMAIL_TRANSPORT: "smtp", RESEND_API_KEY: "" })),
    ).not.toThrow();
    expect(() =>
      parseServerEnv(validEnv({ EMAIL_TRANSPORT: "smtp", RESEND_API_KEY: "   " })),
    ).not.toThrow();
  });

  it("REFUSES an unguarded register endpoint once mail can actually be sent", () => {
    // THE DEFECT. `POST /v1/auth/register` takes an attacker-chosen address and
    // enqueues a verification email to it, and its only bot control is a
    // `turnstileToken` that is verified ONLY when TURNSTILE_SECRET_KEY is set —
    // otherwise AuthModule binds AlwaysAllowCaptchaVerifier, which accepts any
    // string. The existing guard lives inside `if (NODE_ENV === "production")`
    // and this deployment deliberately runs NODE_ENV=development, so it never
    // fires: the identical trap WHOP_ENVIRONMENT exists to escape and that the
    // EMAIL_TRANSPORT rule above was just fixed for.
    //
    // The signal is the SAME CREDENTIAL, and that is the whole design: register
    // is a mail relay only when mail can actually leave. RESEND_API_KEY is the
    // only channel by which it can, so its presence is the exact moment the
    // relay opens — and the rule fires at boot, in the same edit that provisions
    // it, rather than being a control someone must remember to switch on.
    expect(() =>
      parseServerEnv(
        validEnv({
          NODE_ENV: "development",
          EMAIL_TRANSPORT: "resend",
          RESEND_API_KEY: "re_live_a_real_key_that_can_send_mail",
        }),
      ),
    ).toThrow(/TURNSTILE_SECRET_KEY/);
  });

  it("accepts a Resend credential once the captcha secret is supplied alongside it", () => {
    expect(() =>
      parseServerEnv(
        validEnv({
          NODE_ENV: "development",
          EMAIL_TRANSPORT: "resend",
          RESEND_API_KEY: "re_live_a_real_key_that_can_send_mail",
          TURNSTILE_SECRET_KEY: "0x4AAAAAAA_secret",
        }),
      ),
    ).not.toThrow();
  });

  it("STILL BOOTS the deployed shape: development, no Resend key, no captcha key", () => {
    // THE HARD CONSTRAINT, locked as a test — the same one the EMAIL_TRANSPORT
    // rule above is bound by. The deployed API holds no Resend key yet and no
    // Turnstile secret; a rule that demanded the captcha unconditionally, or on
    // any signal this environment already has (an https origin, live Whop,
    // PAYMENTS_ENABLED), would take the live API down on its next deploy. Mail
    // is discarded by LoggingTransport today, so there is no relay to close yet.
    const env = validEnv({
      NODE_ENV: "development",
      WHOP_ENVIRONMENT: "live",
      PAYMENTS_ENABLED: "true",
      EMAIL_TRANSPORT: "smtp",
      SMTP_URL: "smtp://akai-mailpit-7urpbe:1025",
      CORS_ALLOWED_ORIGINS: "https://akai.shop,https://app.akai.shop",
    });
    delete env["RESEND_API_KEY"];
    delete env["TURNSTILE_SECRET_KEY"];

    expect(() => parseServerEnv(env)).not.toThrow();
  });

  it("treats a whitespace-only TURNSTILE_SECRET_KEY as absent, not as a key", () => {
    // `.env.example` ships a bare `TURNSTILE_SECRET_KEY=` and the deployment's
    // env string was seeded from it, so blank must read as "not issued yet" on
    // BOTH sides. It matters twice over: AuthModule and ContactModule branch on
    // `=== undefined || === ""` and would otherwise hand a blank secret to the
    // real verifier, which Cloudflare answers `success:false` for — every
    // registration on the site rejected, with the key looking present.
    expect(() =>
      parseServerEnv(
        validEnv({
          EMAIL_TRANSPORT: "resend",
          RESEND_API_KEY: "re_live_a_real_key_that_can_send_mail",
          TURNSTILE_SECRET_KEY: "   ",
        }),
      ),
    ).toThrow(/TURNSTILE_SECRET_KEY/);

    // And it is normalised, so the module factories see "" rather than "   ".
    expect(
      parseServerEnv(validEnv({ TURNSTILE_SECRET_KEY: "  0x4AAA_secret  " }))
        .TURNSTILE_SECRET_KEY,
    ).toBe("0x4AAA_secret");
  });

  it("refuses production with the Whop boot check disabled", () => {
    // WHOP_BOOT_CHECK=false exists so the stack can run locally without a Whop
    // account. If it could reach production it would silently remove the only
    // check that proves the credentials are real before a customer reaches
    // checkout — so the escape hatch must fail closed.
    expect(() =>
      parseServerEnv(
        validEnv({
          NODE_ENV: "production",
          WHOP_BOOT_CHECK: "false",
          EMAIL_TRANSPORT: "resend",
          RESEND_API_KEY: "re_live",
          TURNSTILE_SECRET_KEY: "0x4AAAAAAA_test_secret",
          CORS_ALLOWED_ORIGINS: "https://akai.shop",
        }),
      ),
    ).toThrow(/WHOP_BOOT_CHECK/);
  });

  it('treats WHOP_BOOT_CHECK="false" as false, not as a truthy string', () => {
    // The bug this locks out: `z.coerce.boolean()` is JavaScript truthiness, so
    // the non-empty string "false" coerces to `true` and the flag does the exact
    // opposite of what the operator wrote.
    expect(parseServerEnv(validEnv({ WHOP_BOOT_CHECK: "false" })).WHOP_BOOT_CHECK).toBe(
      false,
    );
    expect(parseServerEnv(validEnv({ WHOP_BOOT_CHECK: "true" })).WHOP_BOOT_CHECK).toBe(
      true,
    );
    // Absent means enabled: the safe default must not depend on the operator
    // remembering to set it.
    expect(parseServerEnv(validEnv({})).WHOP_BOOT_CHECK).toBe(true);
  });

  it("refuses production with the local Mailpit transport", () => {
    expect(() =>
      parseServerEnv(
        validEnv({
          NODE_ENV: "production",
          TURNSTILE_SECRET_KEY: "0x4AAAAAAA_test_secret",
          CORS_ALLOWED_ORIGINS: "https://akai.shop",
        }),
      ),
    ).toThrow(/order confirmation/);
  });

  it("refuses a plaintext CORS origin in production", () => {
    expect(() =>
      parseServerEnv(
        validEnv({
          NODE_ENV: "production",
          EMAIL_TRANSPORT: "resend",
          RESEND_API_KEY: "re_live",
          TURNSTILE_SECRET_KEY: "0x4AAAAAAA_test_secret",
          CORS_ALLOWED_ORIGINS: "http://insecure.example.com",
        }),
      ),
    ).toThrow(/plaintext origin/);
  });

  it("resolves to SANDBOX outside production, and derives the sandbox base URL", () => {
    // A developer gets test cards without configuring anything. The base URL is
    // derived, never configured: a live key against the sandbox host 401s, so
    // two variables that must agree is a way to point real credentials at a fake
    // processor by editing one of them.
    const config = parseServerEnv(
      validEnv({ ...SANDBOX_ENV, PAYMENTS_ENABLED: "true", WHOP_ENVIRONMENT: "sandbox" }),
    );

    expect(config.whop.environment).toBe("sandbox");
    expect(config.whop.baseUrl).toBe("https://sandbox-api.whop.com/api/v1");
    expect(config.whop.apiKey).toBe(SANDBOX_ENV.WHOP_SANDBOX_API_KEY);
    expect(config.whop.accountId).toBe("biz_sandbox_1");
  });

  it("resolves to LIVE when told to, whatever NODE_ENV says", () => {
    // THE CASE THIS DEPLOYMENT DEPENDS ON. The deployed API deliberately runs
    // NODE_ENV=development, so a pure NODE_ENV rule would hand real customers a
    // sandbox checkout and mark their orders PAID without taking money.
    const config = parseServerEnv(
      validEnv({ ...SANDBOX_ENV, NODE_ENV: "development", WHOP_ENVIRONMENT: "live" }),
    );

    expect(config.whop.environment).toBe("live");
    expect(config.whop.baseUrl).toBe("https://api.whop.com/api/v1");
    expect(config.whop.apiKey).toBe("whop_test_abc123def456ghi789");
  });

  it("REFUSES to boot with sandbox selected while the sandbox keys are absent", () => {
    // Naming the variable, not "sandbox is incomplete" — a boot failure should
    // say which credential to go and fetch.
    // Only once payments are actually engaged: with them off, checkout never
    // reaches Whop and a fresh clone must still boot.
    expect(() =>
      parseServerEnv(validEnv({ PAYMENTS_ENABLED: "true", WHOP_ENVIRONMENT: "sandbox" })),
    ).toThrow(/WHOP_SANDBOX_API_KEY/);
    expect(() =>
      parseServerEnv(validEnv({ PAYMENTS_ENABLED: "false", WHOP_ENVIRONMENT: "sandbox" })),
    ).not.toThrow();
  });

  it("applies the documented WHOP_BASE_URL default in the live case", () => {
    const config = parseServerEnv(validEnv({ WHOP_ENVIRONMENT: "live" }));
    expect(config.whop.baseUrl).toBe("https://api.whop.com/api/v1");
  });

  it("rejects a weak WHOP_WEBHOOK_SECRET — it is the only forgery defence", () => {
    // Signature verification is the entire security boundary on the webhook
    // route: without it, anyone could POST `payment.succeeded`.
    expect(() => parseServerEnv(validEnv({ WHOP_WEBHOOK_SECRET: "ws_short" }))).toThrow(
      /at least 32 characters/,
    );
  });

  it("REJECTS a webhook secret with the ws_ prefix stripped", () => {
    // THE PREFIX IS PART OF THE SIGNING KEY. Whop HMACs with the literal bytes
    // of the secret it issued, prefix included, so a value stored without it
    // derives a DIFFERENT key and every delivery fails verification — a silent
    // 100% rejection rate discovered only when orders stop settling. Asserting
    // the prefix turns that into a boot failure naming the variable.
    expect(() => parseServerEnv(validEnv({ WHOP_WEBHOOK_SECRET: "d".repeat(40) }))).toThrow(
      /ws_/,
    );
  });

  it("requires a dated API version rather than defaulting one", () => {
    // Whop versions payload shapes by date, including the webhook body the
    // settlement check reads. A default would let the pin drift silently.
    const env = validEnv();
    delete env["WHOP_API_VERSION_DATE"];
    expect(() => parseServerEnv(env)).toThrow(/WHOP_API_VERSION_DATE/);
    expect(() => parseServerEnv(validEnv({ WHOP_API_VERSION_DATE: "August 2026" }))).toThrow(
      /YYYY-MM-DD/,
    );
  });

  it("requires the biz_ and prod_ id prefixes", () => {
    expect(() => parseServerEnv(validEnv({ WHOP_ACCOUNT_ID: "acct_1" }))).toThrow(/biz_/);
    expect(() => parseServerEnv(validEnv({ WHOP_PRODUCT_ID: "product_1" }))).toThrow(/prod_/);
  });

  it("accepts a fully-configured production environment", () => {
    const config = parseServerEnv(
      validEnv({
        NODE_ENV: "production",
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "re_live",
        TURNSTILE_SECRET_KEY: "0x4AAAAAAA_test_secret",
        CORS_ALLOWED_ORIGINS: "https://akai.shop",
      }),
    );
    expect(config.NODE_ENV).toBe("production");
  });
});

describe("sendcloud", () => {
  const SENDCLOUD_ENV = {
    SENDCLOUD_PUBLIC_KEY: "pub_key_1",
    SENDCLOUD_SECRET_KEY: "secret_key_1",
    SENDCLOUD_SENDER_ADDRESS_ID: "920582",
  } as const;

  it("is null when none of the keys is set — fulfilment is absent, not broken", () => {
    const config = parseServerEnv(validEnv());
    expect(config.sendcloud).toBeNull();
    expect(config.SENDCLOUD_MODE).toBe("test");
  });

  it("treats bare/blank keys as absent", () => {
    const config = parseServerEnv(
      validEnv({
        SENDCLOUD_PUBLIC_KEY: "",
        SENDCLOUD_SECRET_KEY: "   ",
        SENDCLOUD_SENDER_ADDRESS_ID: "",
        SENDCLOUD_WEBHOOK_SECRET: "",
      }),
    );
    expect(config.sendcloud).toBeNull();
  });

  it("resolves a complete set, defaulting to TEST mode and the v3 base URL", () => {
    const config = parseServerEnv(validEnv(SENDCLOUD_ENV));
    expect(config.sendcloud).toEqual({
      publicKey: "pub_key_1",
      secretKey: "secret_key_1",
      // No dedicated signature key → Sendcloud signs with the secret key (spec §11a).
      webhookSecret: "secret_key_1",
      senderAddressId: 920582,
      mode: "test",
      baseUrl: "https://panel.sendcloud.sc/api/v3",
    });
  });

  it("uses the dedicated webhook signature key when one is set", () => {
    const config = parseServerEnv(
      validEnv({ ...SENDCLOUD_ENV, SENDCLOUD_WEBHOOK_SECRET: "hook_key_1" }),
    );
    expect(config.sendcloud?.webhookSecret).toBe("hook_key_1");
  });

  it("is LIVE only when pinned explicitly", () => {
    const config = parseServerEnv(validEnv({ ...SENDCLOUD_ENV, SENDCLOUD_MODE: "live" }));
    expect(config.sendcloud?.mode).toBe("live");
  });

  it("refuses an unknown mode", () => {
    expect(() =>
      parseServerEnv(validEnv({ ...SENDCLOUD_ENV, SENDCLOUD_MODE: "production" })),
    ).toThrow(/SENDCLOUD_MODE/);
  });

  it.each([
    ["SENDCLOUD_PUBLIC_KEY"],
    ["SENDCLOUD_SECRET_KEY"],
    ["SENDCLOUD_SENDER_ADDRESS_ID"],
  ] as const)("REFUSES to boot with %s missing from a partial set", (missing) => {
    const env = validEnv(SENDCLOUD_ENV);
    delete env[missing];
    expect(() => parseServerEnv(env)).toThrow(new RegExp(`${missing}.*all-or-none`));
  });

  it("refuses a non-positive or non-integer sender address id", () => {
    expect(() =>
      parseServerEnv(validEnv({ ...SENDCLOUD_ENV, SENDCLOUD_SENDER_ADDRESS_ID: "0" })),
    ).toThrow(/SENDCLOUD_SENDER_ADDRESS_ID/);
    expect(() =>
      parseServerEnv(validEnv({ ...SENDCLOUD_ENV, SENDCLOUD_SENDER_ADDRESS_ID: "12.5" })),
    ).toThrow(/SENDCLOUD_SENDER_ADDRESS_ID/);
  });

  it("refuses a webhook secret or a live pin without credentials", () => {
    expect(() => parseServerEnv(validEnv({ SENDCLOUD_WEBHOOK_SECRET: "hook" }))).toThrow(
      /SENDCLOUD_PUBLIC_KEY/,
    );
    expect(() => parseServerEnv(validEnv({ SENDCLOUD_MODE: "live" }))).toThrow(
      /SENDCLOUD_PUBLIC_KEY/,
    );
  });

  it("logs the mode but never the keys", () => {
    const redacted = redactedConfig(
      parseServerEnv(validEnv({ ...SENDCLOUD_ENV, SENDCLOUD_WEBHOOK_SECRET: "hook_key_1" })),
    );
    expect(redacted["SENDCLOUD_MODE"]).toBe("test");
    for (const key of [
      "SENDCLOUD_PUBLIC_KEY",
      "SENDCLOUD_SECRET_KEY",
      "SENDCLOUD_WEBHOOK_SECRET",
      "sendcloud",
    ]) {
      expect(redacted).not.toHaveProperty(key);
    }
  });
});

describe("loadServerConfig", () => {
  it("memoises so repeated reads see one consistent snapshot", () => {
    const env = validEnv();
    const first = loadServerConfig(env);
    const second = loadServerConfig(validEnv({ PORT: "9999" }));
    expect(second).toBe(first);
    expect(second.PORT).toBe(3333);
  });
});

describe("redactedConfig", () => {
  it("includes safe operational keys", () => {
    const redacted = redactedConfig(parseServerEnv(validEnv()));
    expect(redacted["PORT"]).toBe(3333);
    expect(redacted["NODE_ENV"]).toBe("development");
    // Identifiers and endpoints are operationally useful and carry no secret.
    expect(redacted["WHOP_ACCOUNT_ID"]).toBe("biz_test_1");
    // WHICH ENVIRONMENT the process resolved to — the single most useful line in
    // a startup log when a payment behaves unexpectedly, and it names no secret.
    expect(redacted["WHOP_ENVIRONMENT"]).toBe("live");
  });

  it("omits every secret — allowlist, so new secrets are excluded by default", () => {
    const redacted = redactedConfig(parseServerEnv(validEnv()));
    for (const secretKey of [
      "JWT_ACCESS_SECRET",
      "DATABASE_URL",
      "DIRECT_DATABASE_URL",
      "S3_SECRET_ACCESS_KEY",
      "REVALIDATE_SIGNING_SECRET",
      "RESEND_API_KEY",
      "WHOP_API_KEY",
      "WHOP_WEBHOOK_SECRET",
    ]) {
      expect(redacted).not.toHaveProperty(secretKey);
    }
  });
});
