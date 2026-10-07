import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminHttpRequest, AdminHttpResponse } from "./http";

/**
 * The shipping server actions, through a fake transport — the seams either
 * side of `actions.ts` replaced exactly as `actions.test.ts` does (the
 * session-bound client and `revalidatePath`), everything between them real,
 * including the request-schema parses.
 */

const ZONE_ID = "11111111-1111-4111-8111-111111111111";
const RATE_ID = "33333333-3333-4333-8333-333333333333";
const T0 = "2026-09-24T10:00:00.000Z";

const calls: AdminHttpRequest[] = [];
let respond: (input: AdminHttpRequest) => AdminHttpResponse = () => ({ status: 204, body: null });

const revalidatePath = vi.fn<(path: string) => void>();

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("../api/client", () => ({
  apiBaseUrl: () => "http://api.test",
  createApiClient: () => ({}),
}));
vi.mock("../session/server", () => ({
  getSession: async () => null,
  writeSession: async () => undefined,
  clearSession: async () => undefined,
}));
vi.mock("../api/auth", () => ({ refresh: async () => ({ ok: false }) }));
vi.mock("./http-adapter", () => ({
  createAdminHttp: () => ({
    async request(input: AdminHttpRequest): Promise<AdminHttpResponse> {
      calls.push(input);
      return respond(input);
    },
  }),
}));

const {
  createShippingRateAction,
  createShippingZoneAction,
  deleteShippingRateAction,
  updateShippingRateAction,
} = await import("./actions");

const zoneBody = {
  id: ZONE_ID,
  name: "Colombia",
  countryCodes: ["CO"],
  sortOrder: 2,
  createdAt: T0,
  updatedAt: T0,
  rates: [],
};

const rateBody = {
  id: RATE_ID,
  zoneId: ZONE_ID,
  name: { es: "Envío nacional" },
  strategy: "FLAT",
  minValue: null,
  maxValue: null,
  priceGross: 1_500_000,
  currency: "COP",
  freeOverSubtotal: 30_000_000,
  isActive: true,
  transitDaysMin: 2,
  transitDaysMax: 5,
  createdAt: T0,
  updatedAt: T0,
};

beforeEach(() => {
  calls.length = 0;
  revalidatePath.mockReset();
  respond = () => ({ status: 204, body: null });
});

describe("shipping actions", () => {
  it("creates a zone, parsing the body and the response, and refreshes only the shipping screen", async () => {
    respond = () => ({ status: 201, body: zoneBody });

    const result = await createShippingZoneAction({ name: "Colombia", countryCodes: ["CO"], sortOrder: 2 });

    expect(result).toEqual({ ok: true, data: zoneBody });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/admin/shipping/zones",
      body: { name: "Colombia", countryCodes: ["CO"], sortOrder: 2 },
    });
    expect(revalidatePath.mock.calls).toEqual([["/admin/shipping"]]);
  });

  it("carries the API's reason through, for the editor to translate", async () => {
    respond = () => ({
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          reason: "COUNTRY_IN_OTHER_ZONE",
          message: 'IE already belongs to shipping zone "EU".',
          requestId: "req-1",
          timestamp: T0,
        },
      },
    });

    const result = await createShippingZoneAction({ name: "Colombia", countryCodes: ["CO"], sortOrder: 2 });

    expect(result).toMatchObject({ ok: false, code: "CONFLICT", reason: "COUNTRY_IN_OTHER_ZONE" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a country outside the served list without a request", async () => {
    const result = await createShippingZoneAction({ name: "USA", countryCodes: ["US"], sortOrder: 0 });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("creates and updates rates under their zone's path", async () => {
    respond = () => ({ status: 201, body: rateBody });
    await createShippingRateAction(ZONE_ID, {
      name: { es: "Envío nacional" },
      strategy: "FLAT",
      priceGross: 1_500_000,
    });
    respond = () => ({ status: 200, body: { ...rateBody, isActive: false } });
    const updated = await updateShippingRateAction(ZONE_ID, RATE_ID, { isActive: false });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST /admin/shipping/zones/${ZONE_ID}/rates`,
      `PATCH /admin/shipping/zones/${ZONE_ID}/rates/${RATE_ID}`,
    ]);
    expect(calls[1]?.body).toEqual({ isActive: false });
    expect(updated.ok && updated.data.isActive).toBe(false);
  });

  it("refuses a rate with a blank Spanish name before any request", async () => {
    const result = await createShippingRateAction(ZONE_ID, {
      name: { es: "  " },
      strategy: "FLAT",
      priceGross: 1_500_000,
    });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed id before any request", async () => {
    const result = await deleteShippingRateAction("../../orders", RATE_ID);

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
