import { STORE_LOCALE, type CurrencyCode } from "@akai/contracts";

/**
 * The currencies a charge can actually be denominated in.
 *
 * `currencyCodeSchema` is an OPEN three-letter regex, not a closed enum, so the
 * contract would accept "XYZ" — but a discount scoped to a currency the payment
 * provider cannot charge in is a discount that silently never applies.
 *
 * ONE ENTRY: Wompi Colombia charges COP and nothing else, and Akai sells only in
 * Colombia. A wider list (the previous provider charged in ~80 currencies) would
 * offer the operator choices that can never match an order.
 */
export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = ["COP"];

/**
 * The flag for a currency, or null where there honestly is not one.
 *
 * ISO-4217 codes are the ISO-3166 country code plus an initial for the unit —
 * EUR is EU, GBP is GB, JPY is JP — so the flag falls out of the first two
 * letters as regional indicator symbols, with no 84-row lookup table to drift.
 *
 * The exception is the X range, which ISO reserves for units belonging to no
 * single country: XOF is the West African CFA franc across eight states, XCD the
 * East Caribbean dollar across eight more. They get no flag rather than a wrong
 * one — picking any member country's flag would be a claim about a currency
 * union that is not ours to make.
 */
export function currencyFlag(code: CurrencyCode): string | null {
  if (code.startsWith("X")) {
    return null;
  }

  const REGIONAL_INDICATOR_A = 0x1f1e6;
  const LETTER_A = "A".charCodeAt(0);

  const country = code.slice(0, 2);
  let flag = "";
  for (const letter of country) {
    const offset = letter.charCodeAt(0) - LETTER_A;
    if (offset < 0 || offset > 25) {
      return null;
    }
    flag += String.fromCodePoint(REGIONAL_INDICATOR_A + offset);
  }
  return flag;
}

/**
 * "COP 🇨🇴 · peso colombiano", named in Spanish.
 *
 * THE CODE LEADS, AND THE FLAG DOES NOT. A native `<select>` matches type-ahead
 * against the start of the option's text, and an operator reaching this control
 * types "EUR" — it replaced a three-letter code input, which is the muscle
 * memory it inherits. A leading flag is two code points of regional indicator,
 * so it would swallow every keystroke and make the list of 84 navigable only by
 * scrolling.
 *
 * The name comes from `Intl.DisplayNames` in `STORE_LOCALE`, so there is no
 * name table to maintain or to fall out of date.
 */
export function currencyLabel(code: CurrencyCode): string {
  const flag = currencyFlag(code);
  const head = flag === null ? code : `${code} ${flag}`;

  // `of()` returns undefined for a code ICU does not know, and returns the code
  // itself under a minimal-ICU build. Either way the code alone is a usable
  // label, so there is nothing to fall back to but silence.
  const name = new Intl.DisplayNames([STORE_LOCALE], { type: "currency" }).of(code);
  return name === undefined || name === code ? head : `${head} · ${name}`;
}
