import { describe, expect, it } from "vitest";
import { errorEnvelopeSchema } from "@akai/contracts";
import type { ApiError, ApiResult } from "../api/errors";
import type { ServerApiClient } from "../api/client";
import { createAdminHttp } from "./http-adapter";
import { toApiError } from "./http";

/**
 * The adapter REBUILDS the error envelope from the shared client's narrowed
 * failure so the admin layer can re-parse it. That rebuild is a whitelist: a
 * field it does not write back is gone by the time an admin page sees the
 * error, with nothing failing to compile. These tests pin the fields that have
 * to make the round trip.
 */
function failingApi(error: ApiError, status = 400): ServerApiClient {
  const fail = async (): Promise<ApiResult<never>> => ({ ok: false, status, error });

  return {
    authenticated: false,
    session: null,
    request: fail,
    get: fail,
    post: fail,
    patch: fail,
    put: fail,
    delete: fail,
  };
}

const EXPIRED: ApiError = {
  code: "VALIDATION_FAILED",
  message: "That discount code has expired.",
  fields: null,
  reason: "EXPIRED",
  requestId: "req-1",
};

describe("createAdminHttp", () => {
  it("rebuilds an envelope that still carries the domain reason", async () => {
    const http = createAdminHttp(failingApi(EXPIRED));

    const response = await http.request({ method: "GET", path: "/admin/products" });
    const error = toApiError(response);

    expect(error.code).toBe("VALIDATION_FAILED");
    // The whole point: VALIDATION_FAILED alone cannot say WHICH refusal this
    // was, and the sub-code must not be dropped in the rebuild.
    expect(error.reason).toBe("EXPIRED");
    expect(error.requestId).toBe("req-1");
  });

  it("omits reason rather than writing null when the failure carried none", async () => {
    const http = createAdminHttp(
      failingApi({ ...EXPIRED, reason: null, code: "FORBIDDEN" }, 403),
    );

    const response = await http.request({ method: "GET", path: "/admin/products" });

    // `reason` is `.optional()`, not nullable, and the envelope is `.strict()`:
    // writing an explicit null would make the rebuilt body unparseable and cost
    // the code and requestId along with it. This parse is that assertion.
    const parsed = errorEnvelopeSchema.safeParse(response.body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.error.reason).toBeUndefined();
    expect(parsed.success && parsed.data.error.code).toBe("FORBIDDEN");
    expect(toApiError(response).reason).toBeNull();
  });
});
