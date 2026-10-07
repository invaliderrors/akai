import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/**
 * Wompi EVENTS: the envelope, its checksum, and the transaction it carries.
 *
 * Reference: https://docs.wompi.co/docs/colombia/eventos/
 *
 *   POST <our URL>                      header X-Event-Checksum: <checksum>
 *   { event: "transaction.updated",
 *     data: { transaction: { id, status, amount_in_cents, reference, … } },
 *     environment: "test" | "prod",
 *     signature: { properties: ["transaction.id", …], checksum },
 *     timestamp: 1530291411, sent_at: "…" }
 *
 * THE CHECKSUM IS OVER PARSED FIELDS, NOT RAW BYTES — the values named by
 * `signature.properties`, resolved against `data`, concatenated in order, then
 * the `timestamp`, then the events secret, through PLAIN SHA-256 (not an HMAC).
 * That is why this route needs no raw-body middleware: re-serialisation cannot
 * break a checksum that never covered the serialisation.
 */

// ---------------------------------------------------------------------------
// Prototype-pollution filtering
// ---------------------------------------------------------------------------

/**
 * Keys that may never be read out of an inbound body.
 *
 * `JSON.parse` creates `__proto__` as an OWN data property; a spread then writes
 * it through the `Object.prototype.__proto__` setter, replacing the copy's
 * prototype, and zod reads inherited properties — so a field that came from no
 * declared key could reach the settlement check. Filtering the object-model
 * keys at the boundary closes that, whatever the provider.
 */
const FORBIDDEN_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/**
 * Copy a value's own, non-forbidden, enumerable keys into a fresh record.
 * PURE AND TOTAL: anything that is not a plain object contributes nothing.
 */
export function sanitiseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const copied: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!FORBIDDEN_KEYS.includes(key)) {
      copied[key] = entry;
    }
  }
  return copied;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** The statuses a Wompi transaction can be in. */
export const WOMPI_TRANSACTION_STATUSES = [
  "PENDING",
  "APPROVED",
  "DECLINED",
  "VOIDED",
  "ERROR",
] as const;

export const wompiTransactionStatusSchema = z.enum(WOMPI_TRANSACTION_STATUSES);
export type WompiTransactionStatus = z.infer<typeof wompiTransactionStatusSchema>;

/**
 * One Wompi transaction — the SAME shape whether it arrives in an event's
 * `data.transaction` or as `data` of `GET /v1/transactions/{id}`, so the
 * webhook, the return-page confirmation and the sweep all settle from one type.
 *
 * `.strip()` (zod's default), NOT `.strict()` — the recorded exception to the
 * "validate every external input" rule for VENDOR-owned shapes. Wompi adds
 * fields; `.strict()` would turn the first additive field into a rejection of
 * every payment. Nothing unvalidated reaches a handler either way: every field a
 * handler reads is declared and parsed here, and unknown keys are dropped.
 *
 * `amount_in_cents` and `currency` are NULLABLE ON PURPOSE. Absence is never
 * agreement: an APPROVED transaction that does not say what was charged parks
 * the order in PAYMENT_MISMATCH (`AMOUNT_ABSENT`) rather than failing to parse,
 * which would leave it silently stuck instead of loudly flagged.
 */
export const wompiTransactionSchema = z.object({
  id: z.string().min(1).max(64),
  /** A status Wompi may add later parses as a string and is ACKed and ignored. */
  status: z.string().min(1).max(32),
  reference: z.string().min(1).max(255),
  /** Centavos — the same unit as our ledger. No conversion anywhere. */
  amount_in_cents: z.number().nullish(),
  currency: z.string().max(8).nullish(),
  payment_method_type: z.string().max(64).nullish(),
  status_message: z.string().max(500).nullish(),
  customer_email: z.string().max(320).nullish(),
  created_at: z.string().max(64).nullish(),
  finalized_at: z.string().max(64).nullish(),
});

export type WompiTransaction = z.infer<typeof wompiTransactionSchema>;

/**
 * The part of an event the checksum needs — and nothing more. Parsed BEFORE
 * verification, so it is deliberately minimal: a body that cannot even present
 * a checksum is refused as unauthenticated, while a body that verifies but
 * carries an unreadable transaction is a different (and louder) failure.
 */
export const wompiEventEnvelopeSchema = z.object({
  event: z.string().min(1).max(64),
  data: z.record(z.unknown()),
  environment: z.string().max(16).optional(),
  signature: z.object({
    properties: z.array(z.string().min(1).max(128)).max(32),
    checksum: z.string().regex(/^[0-9a-fA-F]{64}$/, "checksum must be 64 hex characters"),
  }),
  timestamp: z.number().int().nonnegative(),
  sent_at: z.string().max(64).optional(),
});

export type WompiEventEnvelope = z.infer<typeof wompiEventEnvelopeSchema>;

/** The event type that carries a transaction. Everything else is ACKed and ignored. */
export const TRANSACTION_UPDATED_EVENT = "transaction.updated";

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

/**
 * Resolve one `signature.properties` path against `data`.
 *
 * Wompi documents paths rooted AT `data` (`transaction.id`); a `data.` prefix is
 * accepted too, as the reference implementation does. OWN properties only, so a
 * path can never walk into the prototype chain.
 */
function resolveProperty(data: Record<string, unknown>, path: string): unknown {
  const segments = (path.startsWith("data.") ? path.slice("data.".length) : path).split(".");

  let current: unknown = data;
  for (const segment of segments) {
    if (
      typeof current !== "object" ||
      current === null ||
      FORBIDDEN_KEYS.includes(segment) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = sanitiseRecord(current)[segment];
  }
  return current;
}

/** A property value as it enters the manifest: absent/null contribute nothing. */
function manifestValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // An object or array is not a value Wompi signs; contributing a stable
  // rendering keeps verification FAILING (as it must) rather than throwing.
  return JSON.stringify(value);
}

/** The concatenated property values followed by the timestamp. No secret. */
export function buildWompiManifest(event: WompiEventEnvelope): string {
  const values = event.signature.properties.map((path) =>
    manifestValue(resolveProperty(event.data, path)),
  );
  return values.join("") + String(event.timestamp);
}

/** `sha256hex(manifest + eventsSecret)`, lower-case. */
export function computeWompiChecksum(event: WompiEventEnvelope, eventsSecret: string): string {
  return createHash("sha256")
    .update(buildWompiManifest(event) + eventsSecret, "utf8")
    .digest("hex");
}

export type ChecksumVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Safe to log: prefixes and shapes only — never the secret or a full digest. */
      readonly diagnostics: {
        readonly receivedChecksumPrefix: string;
        readonly computedChecksumPrefix: string;
        readonly manifestLength: number;
        readonly properties: readonly string[];
        readonly headerDisagrees: boolean;
      };
    };

/**
 * Verify an event's checksum in constant time.
 *
 * CASE-INSENSITIVE: Wompi's docs print the checksum in upper-case hex while the
 * reference implementation compares lower-case; both are the same digest.
 *
 * The `X-Event-Checksum` header, when present, must name the same digest as the
 * body's `signature.checksum` — a request whose two copies disagree was not sent
 * by Wompi as-is.
 */
export function verifyWompiEvent(
  event: WompiEventEnvelope,
  eventsSecret: string,
  headerChecksum: string | undefined,
): ChecksumVerdict {
  const received = event.signature.checksum.toLowerCase();
  const computed = computeWompiChecksum(event, eventsSecret);
  const headerDisagrees =
    headerChecksum !== undefined && headerChecksum.trim().toLowerCase() !== received;

  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(received, "utf8");
  const matches = a.length === b.length && timingSafeEqual(a, b);

  if (matches && !headerDisagrees) {
    return { ok: true };
  }

  return {
    ok: false,
    diagnostics: {
      receivedChecksumPrefix: received.slice(0, 12),
      computedChecksumPrefix: computed.slice(0, 12),
      manifestLength: buildWompiManifest(event).length,
      properties: [...event.signature.properties],
      headerDisagrees,
    },
  };
}
