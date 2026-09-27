import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { authFailureReasonSchema } from "@akai/contracts";

import { insufficientRole, twoFactorEnrolmentRequired, twoFactorRequired } from "./auth.errors";

/**
 * REGRESSION. `FORBIDDEN` is shared by three different situations, and only two
 * of them are ones an operator can fix.
 *
 * Without a machine-readable sub-code the dashboard had nothing to branch on, so
 * an admin whose 15-minute step-up window had lapsed saw "Products could not be
 * loaded / Two-factor authentication required" — the API's own English, rendered
 * raw, with no way to act on it. This pins the sub-code that makes the
 * difference visible to a client that must never read the message.
 */

function payloadOf(error: ForbiddenException): Record<string, unknown> {
  const response = error.getResponse();
  return typeof response === "object" && response !== null
    ? (response as Record<string, unknown>)
    : { message: response };
}

describe("FORBIDDEN sub-codes", () => {
  it("marks a STALE second factor as re-authenticable", () => {
    const payload = payloadOf(twoFactorRequired());
    expect(payload.code).toBe("FORBIDDEN");
    expect(payload.reason).toBe("TWO_FACTOR_REQUIRED");
    // Half of a wire contract: the client parses it against the closed enum.
    expect(authFailureReasonSchema.safeParse(payload.reason).success).toBe(true);
  });

  it("marks a NEVER-ENROLLED privileged account distinctly", () => {
    const payload = payloadOf(twoFactorEnrolmentRequired());
    expect(payload.reason).toBe("TWO_FACTOR_ENROLMENT_REQUIRED");
    expect(authFailureReasonSchema.safeParse(payload.reason).success).toBe(true);
  });

  it("leaves a genuine permission failure WITHOUT a reason", () => {
    // A customer on an admin route is a dead end, not something to re-auth for.
    // Offering "sign in again" there would loop them forever.
    const payload = payloadOf(insufficientRole());
    expect(payload.reason).toBeUndefined();
  });

  it("keeps 403 as the status for all three", () => {
    for (const error of [twoFactorRequired(), twoFactorEnrolmentRequired(), insufficientRole()]) {
      expect(error.getStatus()).toBe(403);
    }
  });
});
