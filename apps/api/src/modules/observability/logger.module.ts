import { Global, Module } from "@nestjs/common";
import { type ServerEnv } from "@akai/config";
import { type Logger, createLogger } from "@akai/observability";
import { SERVER_CONFIG } from "../config/config.module";

/** Injection token for the root pino logger. */
export const LOGGER = Symbol("LOGGER");

/**
 * Binds the shared pino logger (with its PII redaction rules) into the Nest
 * container, so services inject the SAME configured logger rather than each
 * creating their own — which is how an unredacted logger ends up in production.
 */
@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerEnv): Logger =>
        createLogger({
          level: config.LOG_LEVEL,
          nodeEnv: config.NODE_ENV,
          serviceName: "api",
        }),
    },
  ],
  exports: [LOGGER],
})
export class LoggerModule {}
