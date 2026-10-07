import { HttpException } from "@nestjs/common";
import {
  ERROR_STATUS,
  type ErrorCode,
  type ShippingAdminFailureReason,
} from "@akai/contracts";

/**
 * A refused zones/rates admin write — a coarse `code` plus the machine-readable
 * `reason` (`shippingAdminFailureReasonSchema`), exactly the `FulfilmentError`
 * shape. The dashboard branches on the reason against its own catalogue and
 * never renders the English `message`, which is for logs (and therefore may
 * name the conflicting zone and country — staff-only data, and the dashboard
 * already holds the zone list it needs to say the same thing in Spanish).
 */
const CODE_FOR_REASON: Readonly<Record<ShippingAdminFailureReason, ErrorCode>> = {
  // Another row, or another table, is in the way — the request is well formed.
  COUNTRY_IN_OTHER_ZONE: "CONFLICT",
  TAX_RATE_MISSING: "CONFLICT",
  // The merged row is incoherent — the caller fixes the request.
  INVALID_BOUNDS: "VALIDATION_FAILED",
  INVALID_TRANSIT_DAYS: "VALIDATION_FAILED",
};

export class ShippingAdminError extends HttpException {
  public readonly code: ErrorCode;
  public readonly reason: ShippingAdminFailureReason;

  private constructor(reason: ShippingAdminFailureReason, message: string) {
    const code = CODE_FOR_REASON[reason];
    super({ code, reason, message }, ERROR_STATUS[code]);
    this.code = code;
    this.reason = reason;
    this.name = "ShippingAdminError";
  }

  static countryInOtherZone(
    countryCode: string,
    zone: { readonly id: string; readonly name: string },
  ): ShippingAdminError {
    return new ShippingAdminError(
      "COUNTRY_IN_OTHER_ZONE",
      `${countryCode} already belongs to shipping zone "${zone.name}" (${zone.id}). ` +
        `A country may belong to one live zone only; remove it there first.`,
    );
  }

  static taxRateMissing(countryCodes: readonly string[]): ShippingAdminError {
    return new ShippingAdminError(
      "TAX_RATE_MISSING",
      `No current STANDARD tax_rate row for ${countryCodes.join(", ")}. ` +
        `Shipping there could not be taxed, so every quote would fail; add the rate first.`,
    );
  }

  static invalidBounds(): ShippingAdminError {
    return new ShippingAdminError(
      "INVALID_BOUNDS",
      "minValue must be less than maxValue, and a FLAT rate takes no bounds.",
    );
  }

  static invalidTransitDays(): ShippingAdminError {
    return new ShippingAdminError(
      "INVALID_TRANSIT_DAYS",
      "transitDaysMin must not be greater than transitDaysMax.",
    );
  }
}
