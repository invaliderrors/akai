import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetServerConfigCache } from "@akai/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuthController } from "./auth.controller";
import { AuthModule } from "./auth.module";
import { AuthService } from "./auth.service";
import { AccessTokenService } from "./crypto/access-token.service";
import { TotpService } from "./crypto/totp.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { AuthRateLimitGuard } from "./guards/rate-limit.guard";
import { RolesGuard } from "./guards/roles.guard";
import { PASSWORD_HASHER, type PasswordHasher } from "./ports/password-hasher.port";
import { AUTH_REPOSITORY } from "./auth.repository";

/**
 * Composition test.
 *
 * The unit tests construct AuthService by hand, which proves the LOGIC but says
 * nothing about whether the module's providers actually wire together — a
 * mistyped injection token or a missing factory is invisible until boot. This
 * resolves the real module graph, with only Prisma stubbed, so a wiring error
 * fails here rather than at `listen()` on a deploy.
 */

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  DIRECT_DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WHOP_API_KEY: "whop_test_abc123def456ghi789",
  WHOP_ACCOUNT_ID: "biz_test_1",
  WHOP_PRODUCT_ID: "prod_test_1",
  WHOP_WEBHOOK_SECRET: `ws_${"c".repeat(32)}`,
  WHOP_API_VERSION_DATE: "2026-08-14",
  // PINNED, as every real deployment does. NODE_ENV="test" is not production, so
  // an unset value resolves to SANDBOX and the schema then demands a sandbox
  // credential set — the parse throws and takes the whole suite with it.
  WHOP_ENVIRONMENT: "live",
  EMAIL_TRANSPORT: "smtp",
  SMTP_URL: "smtp://localhost:1025",
  EMAIL_FROM: "no-reply@example.com",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "akai-media",
  S3_BUCKET_COA: "akai-coa",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  STOREFRONT_URL: "http://localhost:3000",
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = process.env;
  process.env = { ...TEST_ENV };
  resetServerConfigCache();
});

afterEach(() => {
  process.env = savedEnv;
  resetServerConfigCache();
});

async function compile() {
  const { ConfigModule } = await import("../config/config.module");
  const { LoggerModule } = await import("../observability/logger.module");
  const { PrismaModule } = await import("../prisma/prisma.module");

  return Test.createTestingModule({
    imports: [ConfigModule, LoggerModule, PrismaModule, AuthModule],
  })
    .overrideProvider(PrismaService)
    .useValue({
      $connect: () => Promise.resolve(),
      $disconnect: () => Promise.resolve(),
      ping: () => Promise.resolve(),
    })
    .compile();
}

describe("AuthModule composition", () => {
  it("resolves every provider without a database", async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(AuthService)).toBeInstanceOf(AuthService);
    expect(moduleRef.get(AccessTokenService)).toBeInstanceOf(AccessTokenService);
    expect(moduleRef.get(TotpService)).toBeInstanceOf(TotpService);
    expect(moduleRef.get(AuthController)).toBeInstanceOf(AuthController);
    expect(moduleRef.get(AUTH_REPOSITORY)).toBeDefined();
  });

  it("resolves all three guards", async () => {
    const moduleRef = await compile();

    // These are exported for AppModule to install as APP_GUARD; a guard that
    // cannot be constructed would take the whole API down at startup.
    expect(moduleRef.get(JwtAuthGuard)).toBeInstanceOf(JwtAuthGuard);
    expect(moduleRef.get(RolesGuard)).toBeInstanceOf(RolesGuard);
    expect(moduleRef.get(AuthRateLimitGuard)).toBeInstanceOf(AuthRateLimitGuard);
  });

  it("wires a password hasher driven by the validated config", async () => {
    const moduleRef = await compile();
    const hasher = moduleRef.get<PasswordHasher>(PASSWORD_HASHER);

    const stored = await hasher.hash("a-sufficiently-long-password");
    expect(await hasher.verify(stored, "a-sufficiently-long-password")).toBe(true);
    expect(await hasher.verify(stored, "wrong")).toBe(false);
  });

  it("issues an access token signed with the configured secret", async () => {
    const moduleRef = await compile();
    const tokens = moduleRef.get(AccessTokenService);

    const issued = tokens.issue({
      customerId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      role: "CUSTOMER",
    });

    // Proves parseDurationMs ran against the real JWT_ACCESS_TTL default and
    // the factory produced a usable options object.
    expect(tokens.verify(issued.token).ok).toBe(true);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
