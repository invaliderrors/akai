import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/http";

import { errorMessage, messages } from "./messages";

const { errors } = messages("es");

describe("errorMessage", () => {
  it("translates an API error by its code, never its English message", () => {
    const error = new ApiError(429, {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        requestId: "req-1",
        timestamp: "2026-09-27T00:00:00.000Z",
      },
    });
    expect(errorMessage(errors, error)).toBe(errors.RATE_LIMITED);
  });

  it("treats a failed fetch as a network error", () => {
    expect(errorMessage(errors, new TypeError("fetch failed"))).toBe(errors.NETWORK);
  });

  it("falls back to the generic message for anything else", () => {
    expect(errorMessage(errors, new Error("boom"))).toBe(errors.INTERNAL_ERROR);
  });
});
