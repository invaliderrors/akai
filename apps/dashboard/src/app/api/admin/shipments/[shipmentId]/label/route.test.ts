/**
 * @vitest-environment node
 *
 * Server code, tested in a server environment (see the auth route tests for
 * why jsdom would trip the session module's browser guard).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SHIPMENT = "0b9f6a52-6a8e-4d38-9c1e-5b1d7d9e2a10";
const SIGNED = "https://s3.example/akai-coa/labels/o/1.pdf?X-Amz-Signature=abc";

vi.mock("@/lib/session/server", () => ({
  getSession: () => Promise.resolve({ accessToken: "access-token" }),
}));
vi.mock("@/lib/api/client", () => ({ apiBaseUrl: () => "http://api.internal:3000" }));

const { GET } = await import("./route");

function call(query: string, id = SHIPMENT) {
  const request = new NextRequest(`http://dash.test/api/admin/shipments/${id}/label${query}`);
  return GET(request, { params: Promise.resolve({ shipmentId: id }) });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/admin/shipments/:id/label", () => {
  it("asks the API with the session's bearer and passes its 302 on", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: SIGNED } }));

    const response = await call("?order=AK-2026-000123&locale=es");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGNED);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`http://api.internal:3000/v1/admin/fulfilment/shipments/${SHIPMENT}/label`);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(init?.headers).toMatchObject({ authorization: "Bearer access-token" });
  });

  it("returns the operator to the order with the coded reason on a refusal", async () => {
    // A fresh Response per call: a body can be read once.
    fetchMock.mockImplementation(async () =>
      Response.json(
        {
          error: {
            code: "CONFLICT",
            reason: "LABEL_NOT_AVAILABLE",
            message: "This shipment has no stored label.",
            requestId: "req-1",
            timestamp: "2026-09-24T12:00:00.000Z",
          },
        },
        { status: 409 },
      ),
    );

    const english = await call("?order=AK-2026-000123&locale=en");
    expect(english.status).toBe(303);
    expect(english.headers.get("location")).toBe(
      "http://dash.test/en/admin/orders/AK-2026-000123?labelError=LABEL_NOT_AVAILABLE",
    );

    const spanish = await call("?order=AK-2026-000123&locale=es");
    expect(spanish.headers.get("location")).toBe(
      "http://dash.test/admin/orders/AK-2026-000123?labelError=LABEL_NOT_AVAILABLE",
    );
  });

  it("refuses a malformed id or order number without calling the API", async () => {
    expect((await call("?order=AK-2026-000123", "nope")).status).toBe(400);
    expect((await call("?order=../../evil")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
