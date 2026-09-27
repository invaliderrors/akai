import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeTranslationPort } from "@akai/testing";
import {
  errorCodeSchema,
  translateRequestSchema,
  translationFailureReasonSchema,
  type TranslateRequest,
} from "@akai/contracts";

import { TranslationError } from "./translation.errors";
import { TranslationService } from "./translation.service";

const REQUEST: TranslateRequest = translateRequestSchema.parse({
  source: "es",
  target: "en",
  texts: [
    { key: "name", text: "Creatina monohidratada" },
    { key: "summary", text: "Pureza 99,9 %" },
  ],
});

/**
 * The envelope payload the exception filter will read.
 *
 * `.strict()` IS the "no vendor prose leaks" assertion: anything the mapping
 * layer added beyond these three members — a vendor message, a raw status, a
 * cause — fails this parse rather than reaching a client.
 */
const payloadSchema = z
  .object({
    code: errorCodeSchema,
    reason: translationFailureReasonSchema,
    message: z.string(),
  })
  .strict();

function payloadOf(error: unknown): z.infer<typeof payloadSchema> {
  if (!(error instanceof TranslationError)) {
    throw new Error(`Expected a TranslationError, got ${String(error)}`);
  }
  return payloadSchema.parse(error.getResponse());
}

async function captureError(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (cause: unknown) {
    return cause;
  }
  throw new Error("Expected the call to reject");
}

describe("TranslationService", () => {
  let gateway: FakeTranslationPort;
  let service: TranslationService;

  beforeEach(() => {
    // Braced: an arrow body would RETURN the assignment, and Vitest treats a
    // value returned from a hook as a teardown callback.
    gateway = new FakeTranslationPort();
    service = new TranslationService(gateway);
  });

  it("returns every translation under its own key, in request order", async () => {
    await expect(service.translate(REQUEST)).resolves.toEqual({
      translations: [
        { key: "name", text: "[en] Creatina monohidratada" },
        { key: "summary", text: "[en] Pureza 99,9 %" },
      ],
    });
  });

  it("hands the request to the gateway unchanged", async () => {
    await service.translate(REQUEST);

    expect(gateway.requests).toEqual([REQUEST]);
  });

  it("answers a missing key with a typed refusal rather than a 500", async () => {
    gateway.failNext("NOT_CONFIGURED");

    const error = await captureError(service.translate(REQUEST));
    const payload = payloadOf(error);

    expect(payload.reason).toBe("NOT_CONFIGURED");
    expect(payload.code).toBe("CONFLICT");
    // 409, not 500: the dashboard branches on this to hide its translate
    // action, and a 5xx would page someone for an unset optional key.
    expect(error instanceof TranslationError && error.getStatus()).toBe(409);
  });

  it("separates an exhausted quota from a rate limit", async () => {
    gateway.failNext("QUOTA_EXCEEDED");
    const quota = payloadOf(await captureError(service.translate(REQUEST)));
    expect(quota.reason).toBe("QUOTA_EXCEEDED");
    expect(quota.code).toBe("CONFLICT");

    gateway.failNext("RATE_LIMITED");
    const limited = payloadOf(await captureError(service.translate(REQUEST)));
    // Waiting fixes one and never fixes the other, so they must not share a
    // code either.
    expect(limited.reason).toBe("RATE_LIMITED");
    expect(limited.code).toBe("RATE_LIMITED");
  });

  it("treats an unusable vendor response as a failure, never as empty copy", async () => {
    gateway.failNext("MALFORMED_RESPONSE");

    const payload = payloadOf(await captureError(service.translate(REQUEST)));

    expect(payload.reason).toBe("MALFORMED_RESPONSE");
    // Silently writing blank copy over the other locale is the one genuinely
    // destructive outcome available here.
    expect(payload.code).toBe("CONFLICT");
  });

  it("names no vendor in any message it emits", async () => {
    for (const reason of translationFailureReasonSchema.options) {
      gateway.failNext(reason);
      const payload = payloadOf(await captureError(service.translate(REQUEST)));
      expect(payload.message).not.toMatch(/deepl/i);
    }
  });

  it("maps every declared reason to a 4xx with a parseable payload", async () => {
    // Exhaustive over the contract's union, so a reason added on one side
    // without a mapping on the other fails here rather than becoming a 500.
    for (const reason of translationFailureReasonSchema.options) {
      gateway.failNext(reason);
      const error = await captureError(service.translate(REQUEST));
      const payload = payloadOf(error);

      expect(payload.reason).toBe(reason);
      const status = error instanceof TranslationError ? error.getStatus() : 0;
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
  });

  it("recovers on the next call after a transient failure", async () => {
    gateway.failNext("VENDOR_TIMEOUT");
    await captureError(service.translate(REQUEST));

    await expect(service.translate(REQUEST)).resolves.toEqual({
      translations: [
        { key: "name", text: "[en] Creatina monohidratada" },
        { key: "summary", text: "[en] Pureza 99,9 %" },
      ],
    });
  });
});
