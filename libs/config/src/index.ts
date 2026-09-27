/**
 * @akai/config — typed, zod-validated, fail-fast environment configuration.
 *
 * Deliberately framework-FREE: no @nestjs/* import appears anywhere in this
 * lib. It is tagged `scope:shared`, so a Next app may import it, and dragging
 * Nest's decorator runtime into a browser bundle to read a port number would be
 * absurd. The Nest wiring lives in apps/api/src/modules/config, which wraps
 * `loadServerConfig()` in a provider.
 */

export * from "./schema";
export * from "./load";
