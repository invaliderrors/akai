import { Inject, Injectable } from "@nestjs/common";
import type { CurrencyCode, Minor, Money } from "@akai/contracts";
import { splitGross } from "@akai/money";

import { sharedFreeShippingThreshold } from "./free-shipping";
import type { ShippingCharge } from "../orders/order-totals";
import {
  type ShippingOption,
  type ShippingSelectionContext,
  selectShippingOptions,
} from "./shipping-rate.selector";
import {
  SHIPPING_TAX_RESOLVER,
  type ShippingTaxResolverPort,
} from "./shipping-tax.resolver";
import {
  SHIPPING_REPOSITORY,
  type ShippingRepository,
} from "./shipping.repository";
import { ShippingError } from "./shipping.errors";

/**
 * ShippingService — the server-side source of the shipping charge (spec §13, and
 * the reason issue SEV2 exists: `OrdersService.createFromCart` trusts an
 * `input.shipping: ShippingCharge` that, until now, nothing produced).
 *
 * It does three things nothing else did:
 *  1. RESOLVES A RATE from `shipping_zone` / `shipping_rate` by destination,
 *     weight and subtotal — no more trusting a caller-supplied figure.
 *  2. ENFORCES THE COUNTRY RESTRICTION — a destination with no zone is refused,
 *     which is how a destination the shop may not ship to is
 *     blocked structurally rather than by an if nobody remembers to write.
 *  3. APPLIES free-over-threshold and the weight/price brackets, then splits the
 *     gross rate into the net + taxBps the order totals need.
 *
 * NO CLIENT AMOUNTS: the only client input it accepts is a `shippingMethodId`,
 * and that is VALIDATED against the methods actually offered for the destination.
 * The price is always the server's.
 */

export interface ShippingQuoteInput {
  readonly countryCode: string;
  readonly currency: CurrencyCode;
  /** Cart GROSS subtotal (VAT-inclusive). */
  readonly subtotalGross: Minor;
  /** Total parcel weight in grams. */
  readonly weightGrams: number;
}

export interface ShippingChargeInput extends ShippingQuoteInput {
  /** The method the customer chose. Validated, never trusted for its price. */
  readonly shippingMethodId: string;
}

/** A fully-resolved shipping charge, ready to feed `priceOrder`. */
export interface ResolvedShipping {
  readonly rateId: string;
  /** The rate's name, ready to be stamped onto the immutable order. */
  readonly methodName: string;
  readonly currency: CurrencyCode;
  readonly priceGross: Minor;
  readonly taxRateBps: number;
  readonly net: Minor;
  /** The exact shape `OrdersService.createFromCart` expects. */
  readonly charge: ShippingCharge;
}

@Injectable()
export class ShippingService {
  constructor(
    @Inject(SHIPPING_REPOSITORY) private readonly repository: ShippingRepository,
    @Inject(SHIPPING_TAX_RESOLVER) private readonly taxResolver: ShippingTaxResolverPort,
  ) {}

  /** Whether the store ships to a destination at all. The pure restriction check. */
  async isShippableTo(countryCode: string): Promise<boolean> {
    return (await this.repository.findZoneForCountry(countryCode)) !== null;
  }

  /**
   * The free-shipping threshold that holds wherever the customer ships to, or
   * null when no single figure does (see `sharedFreeShippingThreshold`). Read
   * from the live rate rows, so the storefront's "X € to free shipping" hint
   * can never promise a number the rates do not apply.
   */
  async freeShippingThreshold(): Promise<Money | null> {
    return sharedFreeShippingThreshold(await this.repository.listOfferableRateThresholds());
  }

  /**
   * The methods on offer for a destination + cart, priced for this cart.
   *
   * Throws `destinationNotServed` when no zone covers the country — the country
   * restriction. An empty array (zone exists, but the parcel fits no bracket) is
   * returned rather than thrown, so the UI can say "no method available" without
   * treating it as a hard restriction.
   */
  async listOptions(input: ShippingQuoteInput): Promise<ShippingOption[]> {
    const zone = await this.repository.findZoneForCountry(input.countryCode);
    if (zone === null) {
      throw ShippingError.destinationNotServed(input.countryCode);
    }
    return selectShippingOptions(zone.rates, this.contextOf(input));
  }

  /**
   * Resolve the charge for a chosen method. THE checkout entry point.
   *
   * Every failure mode is distinct and deliberate:
   *  - no zone            → destinationNotServed (country restriction)
   *  - zone, no options   → noMethodAvailable (parcel outside every bracket)
   *  - unknown method id  → methodUnavailable (stale/forged id, or wrong zone)
   */
  async resolveCharge(input: ShippingChargeInput): Promise<ResolvedShipping> {
    const zone = await this.repository.findZoneForCountry(input.countryCode);
    if (zone === null) {
      throw ShippingError.destinationNotServed(input.countryCode);
    }

    const options = selectShippingOptions(zone.rates, this.contextOf(input));
    if (options.length === 0) {
      throw ShippingError.noMethodAvailable(input.countryCode);
    }

    const chosen = options.find((option) => option.rateId === input.shippingMethodId);
    if (chosen === undefined) {
      throw ShippingError.methodUnavailable();
    }

    // Tax is resolved AFTER the method is chosen: a free-over-threshold parcel
    // has priceGross 0, and splitGross(0, bps) is {net:0, tax:0}, so no tax rate
    // lookup is wasted — but we resolve it anyway to stamp the applied rate onto
    // the order even for free shipping, keeping the invoice's tax breakdown
    // complete.
    const taxRateBps = await this.taxResolver.resolveBps(input.countryCode);
    const { net } = splitGross(chosen.priceGross, taxRateBps);

    return {
      rateId: chosen.rateId,
      // Non-blank by construction: `selectShippingOptions` drops a blank-named
      // rate. Stamped onto the order so a later rename never rewrites what the
      // order, its email and its invoice say.
      methodName: chosen.name,
      currency: chosen.currency,
      priceGross: chosen.priceGross,
      taxRateBps,
      net,
      charge: { net, taxRateBps },
    };
  }

  private contextOf(input: ShippingQuoteInput): ShippingSelectionContext {
    if (!Number.isInteger(input.weightGrams) || input.weightGrams < 0) {
      throw ShippingError.noMethodAvailable(input.countryCode);
    }
    return {
      currency: input.currency,
      subtotalGross: input.subtotalGross,
      weightGrams: input.weightGrams,
    };
  }
}
