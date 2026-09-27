import { HttpException } from "@nestjs/common";
import {
  ERROR_STATUS,
  type ErrorCode,
  type TranslationFailureReason,
} from "@akai/contracts";

/**
 * A translation failure, carried into the platform error envelope.
 *
 * WHY NO NEW `ErrorCode` MEMBER. `errorCodeSchema` is a CLOSED enum that both
 * storefront and dashboard components exhaust with
 * `satisfies Record<ErrorCode, string>` message maps — adding a member to it is
 * a deliberate, cross-app change that breaks every one of those files until
 * they are updated. The envelope's `reason` sub-code exists for exactly this
 * situation: a coarse `code` that is correct but cannot separate eight
 * failures which need eight different sentences in the dashboard. This is the
 * same mechanism `DiscountError` uses, for the same reason.
 *
 * The messages below are OURS. They are written for a log and for the
 * `message` field; the dashboard renders its own catalogue keyed on `reason`
 * and never these strings. The vendor's own prose cannot reach this file at
 * all — `TranslationPort` has nowhere to carry it.
 */
const CODE_FOR_REASON: Readonly<Record<TranslationFailureReason, ErrorCode>> = {
  // 409 rather than 500: the request is well-formed and the caller did nothing
  // wrong, but the server's current state cannot satisfy it. A 500 would page
  // someone for a missing optional key, and would tell the dashboard "our bug,
  // retrying is pointless" for states where retrying is exactly right.
  NOT_CONFIGURED: "CONFLICT",
  INVALID_KEY: "CONFLICT",
  QUOTA_EXCEEDED: "CONFLICT",
  VENDOR_UNAVAILABLE: "CONFLICT",
  VENDOR_TIMEOUT: "CONFLICT",
  MALFORMED_RESPONSE: "CONFLICT",
  // 429, so a caller's generic backoff handling applies without knowing what
  // DeepL is.
  RATE_LIMITED: "RATE_LIMITED",
  // The one failure the CALLER can fix, by sending a pair we can translate.
  UNSUPPORTED_LANGUAGE: "VALIDATION_FAILED",
};

const MESSAGE_FOR_REASON: Readonly<Record<TranslationFailureReason, string>> = {
  NOT_CONFIGURED: "Automatic translation is not configured on this deployment.",
  INVALID_KEY: "The configured translation credential was rejected.",
  QUOTA_EXCEEDED: "The translation account has no characters left this period.",
  RATE_LIMITED: "Too many translation requests. Retry shortly.",
  UNSUPPORTED_LANGUAGE: "That language pair cannot be translated.",
  VENDOR_UNAVAILABLE: "The translation service is unavailable.",
  VENDOR_TIMEOUT: "The translation service did not respond in time.",
  MALFORMED_RESPONSE: "The translation service returned an unusable response.",
};

export class TranslationError extends HttpException {
  public readonly code: ErrorCode;
  public readonly reason: TranslationFailureReason;

  private constructor(reason: TranslationFailureReason) {
    const code = CODE_FOR_REASON[reason];
    // AllExceptionsFilter reads `code` and `reason` off this payload and emits
    // them as the envelope's own members.
    super({ code, reason, message: MESSAGE_FOR_REASON[reason] }, ERROR_STATUS[code]);
    this.code = code;
    this.reason = reason;
    this.name = "TranslationError";
  }

  /**
   * The only constructor. Both maps are total over the reason union, so a new
   * reason added to the contract is a compile error here rather than a runtime
   * `undefined` status — which is how a typed error becomes a 500.
   */
  static from(reason: TranslationFailureReason): TranslationError {
    return new TranslationError(reason);
  }
}
