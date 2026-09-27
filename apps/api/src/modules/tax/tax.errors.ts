import { HttpException } from "@nestjs/common";
import { ERROR_STATUS, type ErrorCode } from "@akai/contracts";

/**
 * A tax-resolution failure that carries its machine-readable ErrorCode.
 *
 * Mirrors CatalogError / ShippingError: the global AllExceptionsFilter derives
 * the envelope `code` from the HTTP status today, so the intended code is also
 * carried on the payload for the day the filter prefers it (see followUps).
 */
export class TaxError extends HttpException {
  public readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super({ code, message }, ERROR_STATUS[code]);
    this.code = code;
    this.name = "TaxError";
  }

  /**
   * A served destination with no configured rate for the class.
   *
   * WHY THIS THROWS INSTEAD OF DEFAULTING TO ZERO: a `0` fallback makes the code
   * run and silently sells the order VAT-free — an under-remittance invisible in
   * testing (the arithmetic is consistent, the invoice foots) that surfaces only
   * at the first VAT return, by which point every order in the period is wrong
   * and unfixable. A missing rate is a configuration failure, treated as one.
   */
  static rateUnconfigured(countryCode: string, taxClass: string): TaxError {
    return new TaxError(
      "VALIDATION_FAILED",
      `No ${taxClass} tax rate configured for ${countryCode}. ` +
        `Seed a tax_rate row for this destination before it can be charged — ` +
        `defaulting to 0% would sell the order VAT-free.`,
    );
  }
}
