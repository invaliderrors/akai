import { createHash } from "node:crypto";

/**
 * A GENUINE Wompi event signer, for tests.
 *
 * Why this exists rather than a stub that skips verification: if tests bypassed
 * the checksum, the one check that stops anyone on the internet marking an
 * order PAID would pass every test whether it worked or not.
 *
 * THE SCHEME (docs.wompi.co/docs/colombia/eventos/), written out here
 * INDEPENDENTLY of the API's verifier so the two cross-check each other:
 *
 *   checksum = sha256hex( values of signature.properties, resolved against
 *                         `data`, concatenated in order
 *                       + timestamp
 *                       + events secret )
 *
 * Plain SHA-256, NOT an HMAC. The checksum covers named fields of the parsed
 * body — never its bytes — so these events can be POSTed as ordinary JSON.
 */

/** The events secret every suite signs with. Sandbox-shaped, never real. */
export const TEST_WOMPI_EVENTS_SECRET = "test_events_suite_secret";

/** The properties Wompi's documented example signs. */
export const DEFAULT_WOMPI_SIGNED_PROPERTIES: readonly string[] = [
  "transaction.id",
  "transaction.status",
  "transaction.amount_in_cents",
];

export interface WompiEventBody {
  readonly event: string;
  readonly data: { readonly transaction: Readonly<Record<string, unknown>> };
  readonly environment: string;
  readonly signature: { readonly properties: readonly string[]; readonly checksum: string };
  readonly timestamp: number;
  readonly sent_at: string;
}

export interface SignWompiEventOptions {
  readonly secret?: string;
  readonly properties?: readonly string[];
  /** Unix seconds. Defaults to now. */
  readonly timestamp?: number;
  /** `test` (sandbox) or `prod`. Defaults to `test`. */
  readonly environment?: string;
  readonly event?: string;
}

function valueAt(data: Readonly<Record<string, unknown>>, path: string): string {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || !(segment in current)) {
      return "";
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current === null || current === undefined ? "" : String(current);
}

/** The checksum for a `data` object, independently of the API's implementation. */
export function wompiChecksum(
  data: Readonly<Record<string, unknown>>,
  properties: readonly string[],
  timestamp: number,
  secret: string,
): string {
  const manifest = properties.map((path) => valueAt(data, path)).join("") + String(timestamp);
  return createHash("sha256").update(manifest + secret, "utf8").digest("hex");
}

/**
 * A correctly signed `transaction.updated` event carrying `transaction`.
 */
export function buildSignedWompiEvent(
  transaction: Readonly<Record<string, unknown>>,
  options: SignWompiEventOptions = {},
): WompiEventBody {
  const properties = options.properties ?? DEFAULT_WOMPI_SIGNED_PROPERTIES;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const data = { transaction };

  return {
    event: options.event ?? "transaction.updated",
    data,
    environment: options.environment ?? "test",
    signature: {
      properties: [...properties],
      checksum: wompiChecksum(
        data,
        properties,
        timestamp,
        options.secret ?? TEST_WOMPI_EVENTS_SECRET,
      ),
    },
    timestamp,
    sent_at: new Date(timestamp * 1000).toISOString(),
  };
}

/**
 * A well-formed event signed with the WRONG secret. Every webhook test needs
 * one: the checksum is the entire security boundary on the route.
 */
export function buildForgedWompiEvent(
  transaction: Readonly<Record<string, unknown>>,
): WompiEventBody {
  return buildSignedWompiEvent(transaction, { secret: "test_events_attacker_guess" });
}
