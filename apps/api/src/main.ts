import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { ConfigValidationError, loadServerConfig } from "@akai/config";
import { createLogger } from "@akai/observability";

import { AppModule } from "./app.module";
import { API_GLOBAL_PREFIX, RESEND_WEBHOOK_PATH } from "./common/api-paths";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { createRawBodyMiddleware } from "./common/middleware/raw-body";
import { buildCorsOptions } from "./common/cors-options";
import { OutboxRunner } from "./modules/outbox/outbox.runner";
import { ScheduledJobsRunner } from "./modules/queue/scheduled-jobs.runner";
import { createSecurityHeadersMiddleware } from "./common/middleware/security-headers";

async function bootstrap(): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. CONFIG FIRST — before the Nest container exists.
  //
  // Validating here rather than inside a Nest module means a missing
  // DATABASE_URL produces a readable list of every missing variable, instead of
  // an opaque dependency-resolution failure halfway through bootstrap. This is
  // the fail-fast guarantee: the process cannot reach listen() half-configured.
  // ---------------------------------------------------------------------------
  const config = loadServerConfig();

  const logger = createLogger({
    level: config.LOG_LEVEL,
    nodeEnv: config.NODE_ENV,
    serviceName: "api",
  });

  // NOTE the ABSENCE of `rawBody: true`. That option is global — it retains a
  // second, verbatim Buffer copy of every request body in the platform, when
  // exactly one route needs one. The raw bytes are captured by a middleware
  // mounted on the webhook path alone; see below.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest's own logs go through pino so everything is one JSON stream with the
    // same redaction rules applied.
    bufferLogs: true,
  });

  // ---------------------------------------------------------------------------
  // Security headers, before anything else runs.
  //
  // `x-powered-by` advertises Express to every scanner; drop it. The middleware
  // then sets nosniff / frame-deny / a lockdown CSP (and HSTS in production) on
  // every response — including error responses, because it runs ahead of the
  // router.
  // ---------------------------------------------------------------------------
  app.disable("x-powered-by");
  app.use(
    createSecurityHeadersMiddleware({
      isProduction: config.NODE_ENV === "production",
    }),
  );

  // ---------------------------------------------------------------------------
  // Raw body — ONE ROUTE, and the mounting order is the whole trick.
  //
  // Resend signs `${svix-id}.${svix-timestamp}.${body}` over the EXACT bytes it
  // sent, so its signature can only be checked against bytes that were never
  // parsed and re-serialised. This must run BEFORE Nest registers its JSON
  // body-parser, and it does: `app.use()` binds on the Express instance
  // immediately, whereas the parsers are registered inside `app.init()`, which
  // `app.listen()` triggers further down.
  //
  // The path carries the `v1` prefix explicitly: `setGlobalPrefix` rewrites
  // Nest's ROUTER, not raw Express middleware mounts.
  //
  // The Wompi event route is deliberately NOT here: its checksum covers fields
  // of the parsed body, so the ordinary JSON parser is what it needs.
  // ---------------------------------------------------------------------------
  app.use(RESEND_WEBHOOK_PATH, createRawBodyMiddleware());

  // ---------------------------------------------------------------------------
  // 2. Validation.
  //
  // ts-rest + zod validates the contract routes, but this pipe still guards the
  // routes that are deliberately outside ts-rest (the webhooks and health).
  // `forbidNonWhitelisted` rejects unknown keys rather than stripping
  // them, so a client cannot smuggle a field toward a Prisma `data:` spread.
  // ---------------------------------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Every non-2xx response in the platform is produced here, in one shape.
  app.useGlobalFilters(
    new AllExceptionsFilter(logger, config.NODE_ENV === "production"),
  );

  // ---------------------------------------------------------------------------
  // 3. CORS — an explicit allowlist from validated config.
  //
  // Never a reflected wildcard origin with credentials enabled: that
  // combination lets any site on the internet make authenticated requests with
  // the user's session cookie.
  // ---------------------------------------------------------------------------
  app.enableCors(buildCorsOptions(config.CORS_ALLOWED_ORIGINS));

  // Version the surface from the start. Retrofitting a prefix once clients exist
  // means either breaking them or maintaining two routing tables.
  app.setGlobalPrefix(API_GLOBAL_PREFIX, {
    // Probes must stay at a stable, unversioned path — orchestrator config
    // should not have to change when the API version does.
    exclude: ["health/live", "health/ready"],
  });

  // Drains in-flight requests on SIGTERM so a deploy cannot truncate a payment
  // handler mid-transaction.
  app.enableShutdownHooks();

  // ---------------------------------------------------------------------------
  // 4. OpenAPI.
  //
  // Served for EXTERNAL consumers only. The internal apps are typed through
  // @akai/contracts directly, so this document is derived output and never a
  // hand-maintained second source of truth. Not exposed in production, where it
  // is an unnecessary map of the attack surface.
  // ---------------------------------------------------------------------------
  if (config.NODE_ENV !== "production") {
    const documentConfig = new DocumentBuilder()
      .setTitle("Akai API")
      .setDescription(
        "Source of truth for products, customers, carts, orders, payments and email. " +
          "All money values are INTEGER minor units (cents).",
      )
      .setVersion("1.0")
      .addCookieAuth("akai_session")
      .addTag("health")
      .build();

    const document = SwaggerModule.createDocument(app, documentConfig);
    SwaggerModule.setup("docs", app, document);
  }

  await app.listen(config.PORT);

  // Drain the transactional outbox: deliver order/auth emails and everything
  // else producers commit to
  // `outbox_message`. Started AFTER listen and only from this entrypoint, so
  // integration tests (which never run main.ts) do not open a background
  // poller. Shutdown is handled by the runner's OnApplicationShutdown hook,
  // wired by enableShutdownHooks above.
  app.get(OutboxRunner).start();

  // Start the recurring background sweeps (reservation-expiry, cart-expiry,
  // payment-reconciliation).
  // Same lifecycle as the outbox runner: after listen, only from this
  // entrypoint, stopped via OnApplicationShutdown. Without this, expired stock
  // reservations are never released and abandoned carts never reaped.
  app.get(ScheduledJobsRunner).start();

  logger.info(
    { port: config.PORT, env: config.NODE_ENV },
    "API listening",
  );
}

bootstrap().catch((error: unknown) => {
  // A config error is an OPERATOR error, not a crash: print the actionable
  // message plainly rather than burying it under a stack trace nobody reads.
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exit(1);
  }

  process.stderr.write(
    `\nFailed to start API: ${error instanceof Error ? error.stack : String(error)}\n\n`,
  );
  process.exit(1);
});
