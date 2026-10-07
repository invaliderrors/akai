import { describe, expect, it } from "vitest";

import { identityDocumentTypeSchema } from "@akai/contracts";

import { ApiError } from "@/lib/http";

import { errorMessage, t } from "./messages";

const { errors } = t;

describe("errorMessage", () => {
  it("maps an API error by its code, never its English message", () => {
    const error = new ApiError(429, {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        requestId: "req-1",
        timestamp: "2026-09-27T00:00:00.000Z",
      },
    });
    expect(errorMessage(errors, error)).toBe("Demasiados intentos. Espera un momento.");
  });

  it("treats a failed fetch as a network error", () => {
    expect(errorMessage(errors, new TypeError("fetch failed"))).toBe(errors.NETWORK);
  });

  it("falls back to the generic message for anything else", () => {
    expect(errorMessage(errors, new Error("boom"))).toBe(errors.INTERNAL_ERROR);
  });
});

describe("checkout copy for Colombia", () => {
  it("names every identity document type the API accepts", () => {
    const labels = t.checkout.documentTypes;
    expect(Object.keys(labels).sort()).toEqual([...identityDocumentTypeSchema.options].sort());
    for (const type of identityDocumentTypeSchema.options) {
      expect(labels[type].trim()).not.toBe("");
    }
  });
});
