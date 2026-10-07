import { getRequestConfig } from "next-intl/server";
import { STORE_TIME_ZONE } from "@akai/contracts";
import { loadMessages } from "./messages";

/**
 * next-intl's per-request config, WITHOUT locale routing: the dashboard is
 * Spanish only, so every request gets the one catalogue. next-intl stays as
 * the message reader (`t()`, ICU plurals); there is no `[locale]` segment and
 * no locale middleware.
 *
 * The catalogue is loaded through `./messages`, which imports the JSON
 * statically and validates it, so a malformed catalogue throws on load rather
 * than rendering keys at the customer.
 */
export default getRequestConfig(() =>
  Promise.resolve({ locale: "es", timeZone: STORE_TIME_ZONE, messages: loadMessages() }),
);
