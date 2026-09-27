import { HttpException } from "@nestjs/common";
import { ERROR_STATUS, type ErrorCode, type FulfilmentFailureReason } from "@akai/contracts";

/**
 * A fulfilment refusal, carried into the platform error envelope as a coarse
 * `code` plus the machine-readable `reason` (`fulfilmentFailureReasonSchema`).
 *
 * WHY NO NEW `ErrorCode`: the closed `errorCodeSchema` is exhausted by
 * `satisfies Record<ErrorCode, …>` maps in BOTH web apps; the envelope's
 * `reason` member exists for exactly this — `TranslationError` and
 * `DiscountError` are the precedents. Clients branch on the reason against
 * their own message catalogues; the English messages below are for logs.
 *
 * FULFILMENT_NOT_CONFIGURED IS A 409, NOT A 503. Spec §3.8 says "a coded 503",
 * but `errorCodeSchema` has no 503 member and INTERNAL_ERROR (500) would page
 * someone for an optional feature nobody switched on. 409 CONFLICT + reason is
 * how the DeepL NOT_CONFIGURED precedent answers the identical situation.
 */
const CODE_FOR_REASON: Readonly<Record<FulfilmentFailureReason, ErrorCode>> = {
  // The CALLER can fix these by changing the request.
  SERVICE_POINT_REQUIRED: "VALIDATION_FAILED",
  SERVICE_POINT_NOT_ALLOWED: "VALIDATION_FAILED",
  // Well-formed request; the world (or our configuration) cannot satisfy it.
  SERVICE_POINT_UNAVAILABLE: "CONFLICT",
  FULFILMENT_NOT_CONFIGURED: "CONFLICT",
  VENDOR_UNAVAILABLE: "CONFLICT",
  VENDOR_REJECTED: "CONFLICT",
  CANCEL_REJECTED: "CONFLICT",
  LABEL_NOT_AVAILABLE: "CONFLICT",
};

const MESSAGE_FOR_REASON: Readonly<Record<FulfilmentFailureReason, string>> = {
  SERVICE_POINT_REQUIRED: "This shipping method needs a pickup point.",
  SERVICE_POINT_NOT_ALLOWED: "This shipping method delivers to the address; no pickup point may be chosen.",
  SERVICE_POINT_UNAVAILABLE: "That pickup point is no longer available. Choose another.",
  FULFILMENT_NOT_CONFIGURED: "Shipping labels are not configured on this deployment.",
  VENDOR_UNAVAILABLE: "The shipping provider is unavailable. Try again shortly.",
  VENDOR_REJECTED: "The shipping provider rejected the request.",
  CANCEL_REJECTED: "The carrier no longer allows this label to be cancelled.",
  LABEL_NOT_AVAILABLE: "This shipment has no stored label.",
};

export class FulfilmentError extends HttpException {
  public readonly code: ErrorCode;
  public readonly reason: FulfilmentFailureReason;

  private constructor(reason: FulfilmentFailureReason) {
    const code = CODE_FOR_REASON[reason];
    // AllExceptionsFilter reads `code` and `reason` off this payload and emits
    // them as the envelope's own members.
    super({ code, reason, message: MESSAGE_FOR_REASON[reason] }, ERROR_STATUS[code]);
    this.code = code;
    this.reason = reason;
    this.name = "FulfilmentError";
  }

  /** Both maps are total over the reason union, so a new reason is a compile error here. */
  static from(reason: FulfilmentFailureReason): FulfilmentError {
    return new FulfilmentError(reason);
  }
}
