import type { CurrencyCode, Minor } from "@akai/contracts";
import { formatAggregateMinor, formatMoney } from "@akai/money";

/**
 * The ONE money renderer, in two entry points with deliberately different types.
 *
 * MONEY IS NOT MONOSPACE. The rule that survives from the old shell is "mono
 * for identifiers only" — SKUs, order numbers, tracking numbers, invoice numbers,
 * request ids — and an amount is not one of those. An identifier is compared
 * character by character, which is what a fixed pitch is for; an amount is
 * compared by MAGNITUDE, and `font-variant-numeric: tabular-nums` on the
 * proportional face already gives a column of figures a common digit width.
 * Setting both would buy nothing and would make every price read as code. This
 * is drawn explicitly in 01 Tokens ("Money is not monospace"), where the
 * revenue column is proportional and the SKU beside it is mono.
 *
 * IT NEVER SETS A FONT SIZE, and that is a feature. An amount belongs to the
 * row it sits in — 12px in an admin totals block, 15px in a customer one, 17px
 * on the emphasised total, 22px on a metric tile — so size is inherited and
 * `emphasis` moves the WEIGHT only. A primitive that pinned its own size would
 * have to grow a size prop per surface, and the first call site that forgot one
 * would render an amount typographically detached from its own label.
 *
 * IT NEVER SETS AN ALIGNMENT EITHER. Money is right-aligned wherever it sits in
 * a COLUMN, and the column owns that: a numeric `<td>`, or `TotalsList`'s
 * `<dd>`. The same component also appears mid-sentence ("Reembolsar 4,95 €…"),
 * where pushing the figure to the right margin would be wrong — and `text-align`
 * on an inline element does nothing anyway, so a prop here would be a knob that
 * silently fails half the time.
 *
 * Server component: two Intl calls and a span. Nothing here holds state.
 */

/** Always `--label`, at every weight and on every surface. A price is not meta. */
const BASE_CLASS = "tabular-nums whitespace-nowrap text-[var(--label)]";

/**
 * U+2212 MINUS SIGN, not U+002D HYPHEN-MINUS.
 *
 * ICU emits the ASCII hyphen for a negative currency figure ("-$ 29.900" in
 * es-CO). In a right-aligned stack of tabular figures that
 * hyphen is the one glyph in the string with no tabular width, so the negative
 * row's digits sit a fraction off its neighbours'; U+2212 is drawn to the digit
 * width precisely so a signed column lines up. It is also the character a
 * screen reader is able to announce as a sign at all — a leading hyphen is
 * routinely swallowed as punctuation, which would read a refund aloud as a
 * charge. That risk is why the MEANING of a deduction lives in its row label
 * and never in the sign alone; see `TotalsList`, which requires a label for
 * every line it draws.
 */
const MINUS_SIGN = "−";

/**
 * Safe as a blanket replacement because every figure is formatted in es-CO,
 * which puts no hyphen anywhere else in a currency figure — the group and decimal separators are "." "," and the symbol
 * is "$". A locale with a hyphen in its number pattern would need
 * `formatToParts` and a `minusSign` part instead.
 */
function withTypographicMinus(figure: string): string {
  return figure.replaceAll("-", MINUS_SIGN);
}

interface FigureProps {
  readonly figure: string;
  readonly emphasis: boolean;
  readonly className: string | undefined;
}

function Figure({ figure, emphasis, className }: FigureProps) {
  return (
    <span
      className={`${BASE_CLASS}${emphasis ? " font-semibold" : ""}${
        className === undefined ? "" : ` ${className}`
      }`}
    >
      {withTypographicMinus(figure)}
    </span>
  );
}

export interface MoneyProps {
  /**
   * A REAL amount: a line total, a price, a refund, an order total.
   *
   * `Minor` is branded and capped at `MINOR_MAX`, so it cannot be produced from
   * a bare number without going through `toMinor` or a contract parse. That is
   * the whole guarantee — an amount that reaches this component has been
   * validated as an integer inside the range the ledger can settle.
   */
  readonly amount: Minor;
  readonly currency: CurrencyCode;
  /** Weight only — 600 for a grand total or a headline figure. Never a size. */
  readonly emphasis?: boolean;
  readonly className?: string;
}

export function Money({ amount, currency, emphasis = false, className }: MoneyProps) {
  return <Figure figure={formatMoney(amount, currency)} emphasis={emphasis} className={className} />;
}

export interface AggregateMoneyProps {
  /**
   * An UNBRANDED integer, deliberately: lifetime revenue, a period total, an
   * average order value.
   *
   * Admin aggregates are typed `z.number().int()` rather than parsed as `Minor`
   * (lib/admin/schemas.ts) because an aggregate has no ceiling while `Minor`
   * does. Both ways of forcing one through the branded path are defects:
   * `toMinor` THROWS above `MINOR_MAX`, so the dashboard would start crashing
   * on a successful business, and `isMinor` narrowing returns false for exactly
   * those values, so the fallback branch renders a bare integer — `2400000000`
   * where a euro figure belongs. This component is the third option.
   */
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly emphasis?: boolean;
  readonly className?: string;
}

/**
 * DISPLAY ONLY. `formatAggregateMinor` applies no range check and never throws,
 * which is safe precisely because nothing downstream of this component can move
 * money: an aggregate is never charged, never refunded, never accepted back
 * from a request and never the input to arithmetic. Anything that must be
 * added, compared or settled goes through `Minor` and its overflow guard, which
 * is the cap this path steps around.
 *
 * It shares one Intl call with `formatMoney`, so an aggregate and a line total
 * render as the same peso figure rather than two near-spellings.
 */
export function AggregateMoney({
  amountMinor,
  currency,
  emphasis = false,
  className,
}: AggregateMoneyProps) {
  return (
    <Figure
      figure={formatAggregateMinor(amountMinor, currency)}
      emphasis={emphasis}
      className={className}
    />
  );
}
