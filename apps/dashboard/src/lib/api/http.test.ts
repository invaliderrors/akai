import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiRequest, buildUrl } from "./http";

const BASE = "http://api.internal:3000";
const schema = z.object({ id: z.string() });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildUrl", () => {
  it("inserts the API's version prefix", () => {
    // The API mounts everything under /v1 (apps/api/src/main.ts). Getting this
    // wrong 404s every call in a way that looks like a missing endpoint.
    expect(buildUrl(BASE, "/auth/login")).toBe(`${BASE}/v1/auth/login`);
  });

  it("tolerates a trailing slash on the base and a missing leading slash", () => {
    expect(buildUrl(`${BASE}/`, "auth/login")).toBe(`${BASE}/v1/auth/login`);
  });
});

describe("apiRequest", () => {
  it("returns parsed data on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "abc" })));

    const result = await apiRequest({ baseUrl: BASE, method: "GET", path: "/thing", schema });

    // `toMatchObject` rather than `toEqual`: the point here is the data and
    // status, not asserting on the exact `Headers` instance identity, which a
    // realm-crossing `instanceof` check is not a reliable way to do anyway.
    expect(result).toMatchObject({ ok: true, status: 200, data: { id: "abc" } });
    expect(result.ok && typeof result.headers?.get).toBe("function");
  });

  it("attaches the bearer token when given one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "abc" }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest({
      baseUrl: BASE,
      method: "GET",
      path: "/thing",
      schema,
      accessToken: "the-access-token",
    });

    const init: unknown = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({ headers: { authorization: "Bearer the-access-token" } });
  });

  it("omits the Authorization header when there is no token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "abc" }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest({
      baseUrl: BASE,
      method: "GET",
      path: "/thing",
      schema,
      accessToken: null,
    });

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    // `Bearer null` would be sent as a credential and logged as one.
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("sends a request id that the caller can pin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "abc" }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest({
      baseUrl: BASE,
      method: "GET",
      path: "/thing",
      schema,
      requestId: "fixed-request-id",
    });

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers["x-request-id"]).toBe("fixed-request-id");
  });

  it("parses the platform error envelope on a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "Some fields need attention.",
              fields: [{ path: "email", message: "Invalid email" }],
              requestId: "req-1",
              timestamp: "2026-07-20T12:00:00.000Z",
            },
          },
          400,
        ),
      ),
    );

    const result = await apiRequest({ baseUrl: BASE, method: "POST", path: "/thing", schema });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.requestId).toBe("req-1");
      expect(result.error.fields).toEqual([{ path: "email", message: "Invalid email" }]);
      // Absent on this envelope, and null rather than undefined so callers do
      // not have to ask whether the property exists.
      expect(result.error.reason).toBeNull();
    }
  });

  /**
   * The sub-code has to survive the transport, because `code` cannot express
   * it: every discount refusal the API returns is a VALIDATION_FAILED, so
   * "below the minimum" and "expired" are the same response without `reason`.
   */
  it("carries the envelope's domain reason alongside the code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "That discount code has expired.",
              reason: "EXPIRED",
              requestId: "req-2",
              timestamp: "2026-07-20T12:00:00.000Z",
            },
          },
          400,
        ),
      ),
    );

    const result = await apiRequest({ baseUrl: BASE, method: "POST", path: "/thing", schema });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("EXPIRED");
    }
  });

  it("synthesises an error for a non-envelope failure body", async () => {
    // A load balancer's HTML 502, not our API. Callers must still get a
    // well-formed ApiError rather than tripping over undefined.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 })),
    );

    const result = await apiRequest({ baseUrl: BASE, method: "GET", path: "/thing", schema });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.fields).toBeNull();
      expect(result.error.reason).toBeNull();
    }
  });

  it("maps a bare 401 to UNAUTHENTICATED", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

    const result = await apiRequest({ baseUrl: BASE, method: "GET", path: "/thing", schema });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("FAILS a 2xx whose body does not match the schema", async () => {
    // The central guarantee of this module: a response that has drifted from
    // the contract is surfaced at the boundary, not passed through to become
    // `undefined` inside a component.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ unexpected: true })));

    const result = await apiRequest({ baseUrl: BASE, method: "GET", path: "/thing", schema });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.message).toContain("/thing");
    }
  });

  it("accepts an empty body against a z.undefined() schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const result = await apiRequest({
      baseUrl: BASE,
      method: "DELETE",
      path: "/thing",
      schema: z.undefined(),
    });

    expect(result.ok).toBe(true);
  });

  it("returns a failure instead of throwing when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await apiRequest({ baseUrl: BASE, method: "GET", path: "/thing", schema });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(0);
      expect(result.error.message).toContain("ECONNREFUSED");
    }
  });

  it("serialises a body and sets the content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "abc" }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest({
      baseUrl: BASE,
      method: "POST",
      path: "/thing",
      schema,
      body: { name: "value" },
    });

    const init = fetchMock.mock.calls[0]?.[1] as {
      body: string;
      headers: Record<string, string>;
    };
    expect(init.body).toBe('{"name":"value"}');
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("omits the body key entirely for a GET", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "abc" }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest({ baseUrl: BASE, method: "GET", path: "/thing", schema });

    const init = fetchMock.mock.calls[0]?.[1] as Record<string, unknown>;
    // `body: undefined` on a GET throws in some fetch implementations.
    expect(init).not.toHaveProperty("body");
  });
});
