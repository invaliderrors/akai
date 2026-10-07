import { z } from "zod";

/**
 * Money — integer MINOR units, branded. For the store's currency, COP, a minor
 * unit is a CENTAVO (ISO 4217 exponent 2): $89.000 is stored as 8_900_000 —
 * exactly the `amount_in_cents` a Colombian payment provider expects.
 *
 * WHY THE BRAND LIVES HERE AND NOT IN @akai/money (spec §11 deviation, deliberate):
 * the architecture assigns the `Minor` type to libs/money, but it also declares
 * (§2) that libs/contracts may depend on NOTHING but zod. If both libs declared
 * their own brand we would have two structurally-incompatible `Minor` types and
 * every contracts↔money call site would need a cast — reintroducing exactly the
 * unsafety the brand exists to prevent.
 *
 * Resolution: the brand is declared once, here, at the dependency root.
 * @akai/money imports and re-exports it as the canonical name and owns all
 * ARITHMETIC over it. There is still exactly one money implementation and
 * exactly one money type.
 *
 * The brand makes `Minor` unassignable from a plain `number`, so a peso amount,
 * a quantity, or a percentage can never be silently passed where centavos are
 * expected. Producing one requires `toMinor()` (validated) or a zod parse.
 */
declare const MINOR_BRAND: unique symbol;

export type Minor = number & { readonly [MINOR_BRAND]: "minor" };

/**
 * Largest amount we accept anywhere. Postgres `Int` columns are 32-bit
 * (spec §4) and JS numbers lose integer precision past 2^53, so we clamp well
 * below both: 2_000_000_000 minor units = $20.000.000 COP. A single streetwear
 * order is far under this; anything above it is a bug or an attack. (Note the
 * cap is in MINOR units, so in pesos it is a hundredth of what it would be in
 * a currency whose major unit is worth a hundred times more.)
 */
export const MINOR_MAX = 2_000_000_000;
export const MINOR_MIN = -MINOR_MAX;

/** A signed money amount in minor units. Use for deltas, adjustments, balances. */
export const minorAmountSchema = z
  .number()
  .int("Money must be an integer number of minor units (cents), never a float")
  .min(MINOR_MIN)
  .max(MINOR_MAX)
  .transform((value): Minor => value as Minor);

/** A money amount that may not be negative. Use for prices, totals, captures. */
export const nonNegativeMinorSchema = z
  .number()
  .int("Money must be an integer number of minor units (cents), never a float")
  .min(0, "Amount may not be negative")
  .max(MINOR_MAX)
  .transform((value): Minor => value as Minor);

/** ISO 4217. Uppercase three-letter code; the store sells in COP. */
export const currencyCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, "Currency must be an uppercase ISO-4217 code, e.g. COP");

export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/** An amount paired with its currency. Never pass a bare Minor across a boundary. */
export const moneySchema = z
  .object({
    amount: minorAmountSchema,
    currency: currencyCodeSchema,
  })
  .strict();

export type Money = z.infer<typeof moneySchema>;

/**
 * The ONLY sanctioned way to mint a `Minor` from an untrusted number.
 * Throws rather than coercing: a non-integer amount reaching this function
 * means a float crept into the money path, which must fail loudly.
 */
export function toMinor(value: number): Minor {
  return minorAmountSchema.parse(value);
}

/** Type guard for narrowing `unknown` at a boundary without throwing. */
export function isMinor(value: unknown): value is Minor {
  return minorAmountSchema.safeParse(value).success;
}
