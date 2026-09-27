import { HttpException } from "@nestjs/common";
import { ERROR_STATUS, type ErrorCode } from "@akai/contracts";

/**
 * A shipping failure that carries its machine-readable ErrorCode.
 *
 * Same shape and same known-gap as CatalogError (the global exception filter
 * still derives the envelope `code` from the HTTP status; the precise code is
 * carried here for when that is fixed). Two conditions matter for a client to
 * branch on:
 *
 *  * `destinationNotServed` — 422/VALIDATION: we ship nowhere in this country.
 *    This is the country-restriction gate (spec §13 / §18): a destination
 *    the shop may not ship to has NO shipping zone for it, and that
 *    absence is enforced here rather than by an if-statement someone can forget.
 *  * `methodUnavailable` — the chosen `shippingMethodId` is not offered for this
 *    destination + cart (wrong zone, wrong weight/price bracket, or stale id).
 *    A NOT_FOUND-shaped answer, so a client cannot enumerate which rate ids
 *    exist for other zones.
 */
export class ShippingError extends HttpException {
  public readonly code: ErrorCode;

  /**
   * Marks THE ONE failure that a caller may legitimately treat as a normal
   * answer: "no zone covers this country".
   *
   * A flag rather than a message comparison. `ShippingController` flattens this
   * case into a 200 with `destinationServed: false`, and it shares its ErrorCode
   * (`VALIDATION_FAILED`) with `noMethodAvailable` and `taxUnconfigured` — so
   * neither the class nor the code can distinguish it. The alternative, matching
   * on the message text, stops working silently the first time someone reworded
   * the prose, and the symptom would be an operator misconfiguration being
   * reported to shoppers as "we don't ship to your country".
   */
  public readonly isDestinationNotServed: boolean;

  constructor(code: ErrorCode, message: string, isDestinationNotServed = false) {
    super({ code, message }, ERROR_STATUS[code]);
    this.code = code;
    this.isDestinationNotServed = isDestinationNotServed;
    this.name = "ShippingError";
  }

  static destinationNotServed(countryCode: string): ShippingError {
    return new ShippingError(
      "VALIDATION_FAILED",
      `We do not ship to ${countryCode}. No shipping zone covers this destination.`,
      true,
    );
  }

  static noMethodAvailable(countryCode: string): ShippingError {
    return new ShippingError(
      "VALIDATION_FAILED",
      `No shipping method is available to ${countryCode} for this cart. ` +
        `The parcel may exceed every weight or price bracket configured for the zone.`,
    );
  }

  static methodUnavailable(): ShippingError {
    return new ShippingError(
      "NOT_FOUND",
      `The selected shipping method is not available for this destination and cart.`,
    );
  }

  /**
   * A destination is served (a zone exists) but no tax rate is configured for
   * it. Treated as a configuration failure, not a 0% default — the same
   * philosophy as TaxRateResolver: defaulting shipping to VAT-free is an
   * invisible under-remittance that surfaces at the first VAT return.
   */
  static taxUnconfigured(countryCode: string): ShippingError {
    return new ShippingError(
      "VALIDATION_FAILED",
      `No shipping tax rate is configured for ${countryCode}. ` +
        `Configure a STANDARD tax_rate row before quoting shipping there.`,
    );
  }
}
