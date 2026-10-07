import { beforeEach, describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  loadServerConfig,
  parseServerEnv,
  redactedConfig,
  resetServerConfigCache,
} from "./load";

/** A complete live Wompi key set. Placeholders — never real keys. */
const LIVE_WOMPI = {
  WOMPI_ENVIRONMENT: "live",
  WOMPI_PUBLIC_KEY: "pub_prod_placeholder",
  WOMPI_PRIVATE_KEY: "prv_prod_placeholder",
  WOMPI_INTEGRITY_SECRET: "prod_integrity_placeholder",
  WOMPI_EVENTS_SECRET: "prod_events_placeholder",
} as const;

/** A complete sandbox Wompi key set. */
const SANDBOX_WOMPI = {
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "pub_test_placeholder",
  WOMPI_PRIVATE_KEY: "prv_test_placeholder",
  WOMPI_INTEGRITY_SECRET: "test_integrity_placeholder",
  WOMPI_EVENTS_SECRET: "test_events_placeholder",
} as const;

/** A minimal environment that passes validation. Tests override single keys off this. */
function validEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
    DIRECT_DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
    JWT_ACCESS_SECRET: "a".repeat(32),
    // PINNED, exactly as the deployment does, with keys from the matching
    // (live) Wompi environment.
    ...LIVE_WOMPI,
    EMAIL_TRANSPORT: "smtp",
    SMTP_URL: "smtp://localhost:1025",
    EMAIL_FROM: "no-reply@example.com",
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "akai-media",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
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
    delete env["JWT_ACCESS_SECRET"];
    delete env["S3_BUCKET"];

    try {
      parseServerEnv(env);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      if (!(error instanceof ConfigValidationError)) throw error;
      const paths = error.issues.map((issue) => issue.path);
      expect(paths).toContain("DATABASE_URL");
      expect(paths).toContain("JWT_ACCESS_SECRET");
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
    // transport is never anything but a mistake. Same shape as WOMPI_ENVIRONMENT
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
      WOMPI_ENVIRONMENT: "live",
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
    // fires: the identical trap WOMPI_ENVIRONMENT exists to escape and that the
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
    // any signal this environment already has (an https origin, live Wompi,
    // PAYMENTS_ENABLED), would take the live API down on its next deploy. Mail
    // is discarded by LoggingTransport today, so there is no relay to close yet.
    const env = validEnv({
      NODE_ENV: "development",
      WOMPI_ENVIRONMENT: "live",
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

  it('treats PAYMENTS_ENABLED="false" as false, not as a truthy string', () => {
    // The bug this locks out: `z.coerce.boolean()` is JavaScript truthiness, so
    // the non-empty string "false" coerces to `true`.
    expect(parseServerEnv(validEnv({ PAYMENTS_ENABLED: "false" })).PAYMENTS_ENABLED).toBe(
      false,
    );
    expect(parseServerEnv(validEnv({})).PAYMENTS_ENABLED).toBe(true);
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

  it("derives the sandbox endpoints from WOMPI_ENVIRONMENT=sandbox", () => {
    // The base URL is derived, never configured: two variables that must agree
    // is a way to point real credentials at a fake processor by editing one.
    const config = parseServerEnv(validEnv({ ...SANDBOX_WOMPI }));

    expect(config.wompi).toEqual({
      environment: "sandbox",
      publicKey: "pub_test_placeholder",
      privateKey: "prv_test_placeholder",
      integritySecret: "test_integrity_placeholder",
      eventsSecret: "test_events_placeholder",
      apiBaseUrl: "https://sandbox.wompi.co/v1",
      checkoutUrl: "https://checkout.wompi.co/p/",
      eventEnvironment: "test",
    });
  });

  it("derives the production endpoints from WOMPI_ENVIRONMENT=live, whatever NODE_ENV says", () => {
    // THE CASE THE DEPLOYMENT DEPENDS ON: it may run NODE_ENV=development, so
    // the environment is read from the explicit pin and nothing else.
    const config = parseServerEnv(validEnv({ NODE_ENV: "development" }));

    expect(config.wompi?.environment).toBe("live");
    expect(config.wompi?.apiBaseUrl).toBe("https://production.wompi.co/v1");
    expect(config.wompi?.eventEnvironment).toBe("prod");
  });

  it("resolves an UNSET environment to sandbox — never silently to live", () => {
    const env = validEnv({ ...SANDBOX_WOMPI });
    delete env["WOMPI_ENVIRONMENT"];

    expect(parseServerEnv(env).WOMPI_ENVIRONMENT).toBe("sandbox");
  });

  it("REFUSES production without an explicit WOMPI_ENVIRONMENT", () => {
    const env = validEnv({
      NODE_ENV: "production",
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "re_live",
      TURNSTILE_SECRET_KEY: "0x4AAAAAAA_test_secret",
      CORS_ALLOWED_ORIGINS: "https://akai.shop",
    });
    delete env["WOMPI_ENVIRONMENT"];

    expect(() => parseServerEnv(env)).toThrow(/WOMPI_ENVIRONMENT must be set explicitly/);
  });

  it("REFUSES sandbox in production", () => {
    expect(() =>
      parseServerEnv(
        validEnv({
          ...SANDBOX_WOMPI,
          NODE_ENV: "production",
          EMAIL_TRANSPORT: "resend",
          RESEND_API_KEY: "re_live",
          TURNSTILE_SECRET_KEY: "0x4AAAAAAA_test_secret",
          CORS_ALLOWED_ORIGINS: "https://akai.shop",
        }),
      ),
    ).toThrow(/cannot be "sandbox" in production/);
  });

  it("REFUSES a key from the other environment, naming the variable", () => {
    // A sandbox events secret on a live deployment rejects every genuine
    // webhook; a sandbox private key 401s every confirmation. Both are boot
    // failures here instead of a silent outage.
    expect(() =>
      parseServerEnv(validEnv({ WOMPI_EVENTS_SECRET: "test_events_placeholder" })),
    ).toThrow(/WOMPI_EVENTS_SECRET does not belong to the "live" Wompi environment/);
    expect(() =>
      parseServerEnv(validEnv({ ...SANDBOX_WOMPI, WOMPI_PRIVATE_KEY: "prv_prod_placeholder" })),
    ).toThrow(/WOMPI_PRIVATE_KEY does not belong to the "sandbox" Wompi environment/);
  });

  it("never echoes a mismatched key in the error", () => {
    try {
      parseServerEnv(validEnv({ WOMPI_INTEGRITY_SECRET: "test_integrity_s3cr3t_value" }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(String(error)).not.toContain("s3cr3t_value");
    }
  });

  it("requires every key once payments are engaged, and none while they are off", () => {
    for (const name of [
      "WOMPI_PUBLIC_KEY",
      "WOMPI_PRIVATE_KEY",
      "WOMPI_INTEGRITY_SECRET",
      "WOMPI_EVENTS_SECRET",
    ]) {
      const env = validEnv({ PAYMENTS_ENABLED: "true" });
      delete env[name];
      expect(() => parseServerEnv(env)).toThrow(new RegExp(`${name} is required`));
    }

    const bare = validEnv({ PAYMENTS_ENABLED: "false" });
    for (const name of [
      "WOMPI_ENVIRONMENT",
      "WOMPI_PUBLIC_KEY",
      "WOMPI_PRIVATE_KEY",
      "WOMPI_INTEGRITY_SECRET",
      "WOMPI_EVENTS_SECRET",
    ]) {
      delete bare[name];
    }
    const config = parseServerEnv(bare);
    // NULL, not empty strings: an empty events secret would make the webhook
    // checksum computable by anyone.
    expect(config.wompi).toBeNull();
  });

  it("treats a blank key as absent", () => {
    expect(() => parseServerEnv(validEnv({ WOMPI_PUBLIC_KEY: "  " }))).toThrow(
      /WOMPI_PUBLIC_KEY is required/,
    );
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
    // The public key is public by definition: it rides on every checkout URL.
    expect(redacted["WOMPI_PUBLIC_KEY"]).toBe("pub_prod_placeholder");
    // WHICH ENVIRONMENT the process resolved to — the single most useful line in
    // a startup log when a payment behaves unexpectedly, and it names no secret.
    expect(redacted["WOMPI_ENVIRONMENT"]).toBe("live");
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
      "WOMPI_PRIVATE_KEY",
      "WOMPI_INTEGRITY_SECRET",
      "WOMPI_EVENTS_SECRET",
      "wompi",
    ]) {
      expect(redacted).not.toHaveProperty(secretKey);
    }
  });
});
