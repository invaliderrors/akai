/**
 * TEST MODE — never buy a real carrier label outside the live deployment.
 *
 * Sendcloud has NO sandbox (spec §1 S5): every announced shipment is a real,
 * billed label. So `SENDCLOUD_MODE=test` — the DEFAULT in `libs/config` —
 * swaps the rate's mapped option for Sendcloud's own `sendcloud:letter`, an
 * unstamped letter that costs nothing (spike §11a G3: announce → READY_TO_SEND
 * with a tracking number and an inline A6 PDF, cancel → 202). The whole label
 * pipeline (announce, 409 reuse, label storage, cancel, tracking) runs for real
 * against Sendcloud; only the product changes.
 *
 * WHO CALLS THIS: the label service, immediately before `announceShipment`,
 * with `config.sendcloud.mode`. It is a pure function rather than behaviour
 * hidden inside the HTTP client so that (a) the substitution is visible at the
 * one call site that buys labels, and (b) the order's snapshotted
 * `sendcloudOptionCode` stays the REAL mapping — flipping the deployment to
 * `live` then ships already-paid orders with their real carrier.
 *
 * Two consequences staff will notice in test mode, both expected:
 *  - the pickup point is NOT sent (a letter cannot go to a service point —
 *    `servicePointIdForMode` drops it), and
 *  - Sendcloud merges `house_number` into `address_line_1` on the letter label.
 *
 * Mirrors WHOP_ENVIRONMENT: the live deployment pins `SENDCLOUD_MODE=live`
 * explicitly; nothing derives it from NODE_ENV (which is `development` on the
 * deployed API on purpose).
 */

export type SendcloudMode = "test" | "live";

/** Sendcloud's unstamped-letter product — free, tracked, never delivered anywhere. */
export const TEST_MODE_SHIPPING_OPTION_CODE = "sendcloud:letter";

/** The option code to announce with: the mapped one in live, the letter in test. */
export function effectiveShippingOptionCode(mode: SendcloudMode, mappedCode: string): string {
  return mode === "live" ? mappedCode : TEST_MODE_SHIPPING_OPTION_CODE;
}

/** The service point to announce with: the chosen one in live, none for a test letter. */
export function servicePointIdForMode(
  mode: SendcloudMode,
  servicePointId: string | null,
): string | null {
  return mode === "live" ? servicePointId : null;
}
