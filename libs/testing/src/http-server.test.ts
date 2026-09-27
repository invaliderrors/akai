import { describe, expect, it } from "vitest";

import { httpServerOf } from "./http-server";

/**
 * The adapter exists because `INestApplication.getHttpServer()` is declared
 * `any`, which made every `request(app.getHttpServer())` in the suite an
 * unchecked value. These tests pin the two behaviours that makes worthwhile: it
 * hands back the SAME server object, and it refuses anything that is not one
 * rather than passing the problem down into supertest.
 */

describe("httpServerOf", () => {
  it("returns the server the application exposes, unchanged", () => {
    const server = { listen: () => undefined, address: () => null };

    expect(httpServerOf({ getHttpServer: () => server })).toBe(server);
  });

  it("accepts a callable server — Express apps are functions, not plain objects", () => {
    const app = Object.assign(() => undefined, { listen: () => undefined });

    expect(httpServerOf({ getHttpServer: () => app })).toBe(app);
  });

  it("throws when the app returns something that cannot be driven", () => {
    // The failure this replaces is an inscrutable one raised deep inside
    // supertest, several frames from the bootstrap change that caused it.
    expect(() => httpServerOf({ getHttpServer: () => undefined })).toThrow(TypeError);
    expect(() => httpServerOf({ getHttpServer: () => null })).toThrow(TypeError);
    expect(() => httpServerOf({ getHttpServer: () => ({}) })).toThrow(/listen/);
  });
});
