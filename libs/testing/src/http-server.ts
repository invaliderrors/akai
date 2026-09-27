import type { App } from "supertest/types";

/**
 * A typed adapter over `INestApplication.getHttpServer()`.
 *
 * WHY THIS EXISTS. Nest declares `getHttpServer(): any` — it has to, because the
 * concrete server type depends on which HTTP adapter is installed. Every suite
 * in the repo then wrote `request(app.getHttpServer())`, which quietly passes an
 * `any` into supertest's `App` parameter. That is a single unchecked value at
 * the root of every HTTP assertion in the test suite: if a bootstrap change made
 * `getHttpServer()` return something supertest cannot drive, nothing in the type
 * system would have said so, and the failure would surface as an inscrutable
 * runtime error inside supertest.
 *
 * CLAUDE.md's rule for exactly this situation is "wrap loose library types in a
 * typed adapter". This is that adapter: `unknown` in, a runtime check, `App` out.
 *
 * The check is deliberately shallow — `listen` is the one member supertest
 * requires of an unstarted server, and re-implementing Node's `http.Server`
 * shape here would be a second, worse copy of a type that already exists.
 */
export interface HasHttpServer {
  getHttpServer(): unknown;
}

export function httpServerOf(app: HasHttpServer): App {
  const server: unknown = app.getHttpServer();
  if (!isApp(server)) {
    throw new TypeError(
      "getHttpServer() did not return something supertest can drive (no listen()).",
    );
  }
  return server;
}

function isApp(value: unknown): value is App {
  if (value === null) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  return "listen" in value && typeof value.listen === "function";
}
