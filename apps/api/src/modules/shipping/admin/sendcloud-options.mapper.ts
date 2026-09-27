import {
  currencyCodeSchema,
  type SendcloudShippingOption as SendcloudOptionDto,
  type ShippingDeliveryType,
} from "@akai/contracts";
import { fromDecimalString } from "@akai/money";

import type { SendcloudShippingOption } from "../../fulfilment/sendcloud/sendcloud.port";

/**
 * Sendcloud's shipping options (already narrowed by `SendcloudClient`) → the
 * rate editor's option picker.
 *
 * Pure, so it is tested against the fixtures captured from the real account.
 */

/**
 * `functionalities.last_mile` values that mean "the customer collects it".
 * Sendcloud documents `service_point` and `locker`; `pickup_point` is accepted
 * too so a renamed value does not quietly turn a locker method into HOME.
 */
const COLLECTION_LAST_MILES: ReadonlySet<string> = new Set([
  "service_point",
  "locker",
  "pickup_point",
]);

/**
 * Sendcloud's OWN products — `sendcloud:letter` ("Unstamped letter") — are not
 * carriers a customer-facing rate can be mapped to. TEST mode substitutes the
 * letter automatically at label time (`test-mode.ts`), so offering it in the
 * picker would only let staff map a real rate to a fake product.
 */
const NON_CARRIER_CODES: ReadonlySet<string> = new Set(["sendcloud"]);

export function deliveryTypeFor(option: {
  readonly lastMile: string | null;
  readonly requiresServicePoint: boolean;
}): ShippingDeliveryType {
  if (option.requiresServicePoint) {
    return "SERVICE_POINT";
  }
  return option.lastMile !== null && COLLECTION_LAST_MILES.has(option.lastMile)
    ? "SERVICE_POINT"
    : "HOME";
}

/**
 * The merchant's quoted cost, in minor units — through `libs/money`'s
 * `fromDecimalString`, never a float. Null when there is no quote, the currency
 * is not an ISO code, or the decimal is not exactly readable: it is an
 * informational figure for staff, and a guessed one is worse than none.
 */
function merchantCost(
  quote: SendcloudShippingOption["quoteTotal"],
): Pick<SendcloudOptionDto, "merchantCost" | "currency"> {
  if (quote === null) {
    return { merchantCost: null, currency: null };
  }
  const currency = currencyCodeSchema.safeParse(quote.currency);
  if (!currency.success) {
    return { merchantCost: null, currency: null };
  }
  try {
    const amount = fromDecimalString(quote.value, currency.data);
    return amount < 0
      ? { merchantCost: null, currency: null }
      : { merchantCost: amount, currency: currency.data };
  } catch {
    return { merchantCost: null, currency: null };
  }
}

export function toSendcloudOptionDtos(
  options: readonly SendcloudShippingOption[],
): SendcloudOptionDto[] {
  return options
    .filter((option) => !NON_CARRIER_CODES.has(option.carrierCode))
    .map((option) => ({
      code: option.code,
      name: option.name,
      carrierCode: option.carrierCode,
      carrierName: option.carrierName,
      lastMile: option.lastMile,
      deliveryType: deliveryTypeFor(option),
      requiresServicePoint: option.requiresServicePoint,
      requiredFields: [...option.requiredFields],
      ...merchantCost(option.quoteTotal),
    }))
    .sort((a, b) => a.carrierCode.localeCompare(b.carrierCode) || a.code.localeCompare(b.code));
}
