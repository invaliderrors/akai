import { Global, Module } from "@nestjs/common";
import { type ServerEnv, loadServerConfig } from "@akai/config";

/**
 * Injection token for the validated environment.
 *
 * A token rather than a class because `ServerEnv` is a zod-inferred TYPE, not a
 * class, so there is no constructor for Nest's metadata-based resolution to key
 * on. Inject it with `@Inject(SERVER_CONFIG)`.
 */
export const SERVER_CONFIG = Symbol("SERVER_CONFIG");

/**
 * Global so no other module has to import ConfigModule just to read a port.
 * `@Global()` is used sparingly in this codebase; configuration is the textbook
 * case for it — it is read everywhere and depends on nothing.
 *
 * NOTE: validation runs in main.ts BEFORE the Nest container is created, so a
 * misconfigured process dies with a readable message rather than an opaque
 * dependency-resolution error mid-bootstrap. This factory therefore hits the
 * memoised snapshot and cannot fail here.
 */
@Global()
@Module({
  providers: [
    {
      provide: SERVER_CONFIG,
      useFactory: (): ServerEnv => loadServerConfig(),
    },
  ],
  exports: [SERVER_CONFIG],
})
export class ConfigModule {}
