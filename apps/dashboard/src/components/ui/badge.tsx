import type { BadgeTone } from "@/lib/status";

import { Icon } from "./icon";

/**
 * The three read-only capsules: a status `Badge`, a `Counter` and a `LotChip`.
 *
 * COLOUR IS NEVER THE SIGNAL. Every badge carries its own text, so the state
 * survives greyscale, colour blindness and a photocopied packing slip
 * (WCAG 1.4.1). The tone repeats the label; it never replaces it. That is also
 * why `attention` swaps the dot for a symbol rather than simply going redder.
 *
 * `label` IS ALWAYS AN ALREADY-TRANSLATED STRING. Nothing here looks a message
 * up and nothing here ever sees a raw enum member: `ui/status-badge.tsx` owns
 * the (domain, member) -> tone + message-key resolution and hands the finished
 * text down. A primitive that called `useTranslations` itself would have to be
 * a client component and would pin every badge in the app to one namespace.
 *
 * DENSITY IS A PROP AND NOT `var(--badge-h)`, deliberately. Height, type size,
 * dot and gap are ONE typographic decision; reading the height off the cascade
 * while the other three come from a prop is how a badge ends up an 18px capsule
 * with 13px text in it — a comfortable badge rendered inside the compact admin
 * shell. The two heights below ARE `--badge-h`'s two values; they are inlined
 * so the four numbers cannot disagree, not because the token is wrong.
 *
 * None of the three is interactive. The artboard's one focusable badge belonged
 * to the provider-sync surface the plan's audit lists as dropped, so there is no
 * `:focus-visible` treatment here on purpose. A badge that grows an action
 * becomes a Button wearing badge geometry, not a badge with an onClick.
 */

/** Compact is the macOS text table, comfortable the iOS list. Same set, two sizes. */
export type BadgeDensity = "compact" | "comfortable";

interface BadgeMetrics {
  /** Capsule geometry: height, gap, inline padding and type size. */
  readonly capsule: string;
  readonly dot: string;
  /** Edge of the `attention` glyph, in CSS pixels. */
  readonly glyph: number;
}

const BADGE_DENSITY: Readonly<Record<BadgeDensity, BadgeMetrics>> = {
  compact: { capsule: "h-[18px] gap-[5px] px-[7px] text-[11px]", dot: "h-[5px] w-[5px]", glyph: 11 },
  // 12, not 11: the artboard draws the glyph a pixel up at comfortable exactly
  // as it does the dot (6 vs 5). The plan's flat "11px triangle-alert" quotes
  // its compact example row.
  comfortable: { capsule: "h-[24px] gap-[6px] px-[9px] text-[13px]", dot: "h-[6px] w-[6px]", glyph: 12 },
};

/**
 * Fill from `*-fill`, text from `*-text`. The `-text` variant is the one that
 * meets AA on its own fill; the bare indicator colour is for the dot only and
 * would fail as text on the same tint.
 *
 * `attention` is the single solid fill in the set — `--attention-fill` is the
 * deep red and `--attention-text` is white — and it has exactly two sanctioned
 * uses in the whole product (order PAYMENT_MISMATCH, and zero-available on an
 * ACTIVE product). The cap is enforced where the tones are assigned, in
 * `lib/status`, not here: this component draws whatever tone it is handed.
 */
const TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: "bg-[var(--neutral-fill)] text-[var(--neutral-text)]",
  progress: "bg-[var(--progress-fill)] text-[var(--progress-text)]",
  success: "bg-[var(--success-fill)] text-[var(--success-text)]",
  warning: "bg-[var(--warning-fill)] text-[var(--warning-text)]",
  danger: "bg-[var(--danger-fill)] text-[var(--danger-text)]",
  attention: "bg-[var(--attention-fill)] text-[var(--attention-text)]",
};

/**
 * Keyed on the tones that HAVE a dot, so `attention` cannot be given one by
 * accident: it draws a triangle-alert instead, and the narrowing below is what
 * makes that structural rather than a convention.
 */
const DOT_CLASS: Readonly<Record<Exclude<BadgeTone, "attention">, string>> = {
  neutral: "bg-[var(--neutral)]",
  progress: "bg-[var(--progress)]",
  success: "bg-[var(--success)]",
  warning: "bg-[var(--warning)]",
  danger: "bg-[var(--danger)]",
};

/**
 * A badge sitting on an accent-filled selected row.
 *
 * Every `*-fill` tint is a pale wash designed for a white surface and vanishes
 * on `--accent`; a translucent white knocked out of the accent is the only
 * treatment that survives it. `bg-white/20` rather than a token because this is
 * the one colour in the kit with no role token — the surface it sits on is
 * itself the accent, so there is nothing else it could be — and it is a theme
 * colour with an opacity modifier, not a raw hex.
 */
const ON_ACCENT_CLASS = "bg-white/20 text-[var(--label-on-accent)]";

export interface BadgeProps {
  readonly tone: BadgeTone;
  /** Already translated. Never an enum member, never a server-written message. */
  readonly label: string;
  /** Defaults to comfortable, matching the bare-root density defaults. */
  readonly density?: BadgeDensity;
  /**
   * Selected-row treatment for a table row filled with `--accent`. It overrides
   * the tone's colours — including `attention`'s — because none of them are
   * legible on that fill. The label and, for `attention`, the symbol are what
   * carry the state across, which is the point of never encoding it in colour.
   */
  readonly onAccent?: boolean;
  readonly className?: string;
}

export function Badge({ tone, label, density = "comfortable", onAccent = false, className }: BadgeProps) {
  const metrics = BADGE_DENSITY[density];

  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-[var(--r-pill)] font-semibold ${
        metrics.capsule
      } ${onAccent ? ON_ACCENT_CLASS : TONE_CLASS[tone]}${className === undefined ? "" : ` ${className}`}`}
    >
      {/* `whitespace-nowrap` above is load-bearing: the height is fixed, and
          "Falta método de pago" in a narrow table column would otherwise wrap
          to two lines inside an 18px capsule and spill out of it. */}
      {tone === "attention" ? (
        <Icon name="triangle-alert" size={metrics.glyph} />
      ) : (
        <span className={`shrink-0 rounded-full ${metrics.dot} ${onAccent ? "bg-current" : DOT_CLASS[tone]}`} />
      )}
      {label}
    </span>
  );
}

/** Neutral unless the count is a problem — a queue length is not an alarm. */
export type CounterTone = "neutral" | "danger";

/**
 * `--fill-tertiary` (#e8e8ed) and not `--neutral-fill` (#f2f2f7), matching the
 * artboard: a counter usually sits inside a selected or hovered nav row, and
 * the badge's paler tint disappears against it.
 *
 * The problem fill is `--danger-text`, the deep red — the same value as
 * `--attention-fill` but a different role, and deliberately reached by the
 * `danger` name. `attention` has a budget of two uses in the product and a
 * sidebar count is not one of them; spending the token here would make the cap
 * unenforceable. (The customer tab bar's badge uses `--danger`, the brighter
 * indicator red, for the same reason in the other direction.)
 */
const COUNTER_TONE: Readonly<Record<CounterTone, string>> = {
  neutral: "bg-[var(--fill-tertiary)] text-[var(--neutral-text)]",
  danger: "bg-[var(--danger-text)] text-[var(--label-on-accent)]",
};

/** `min-w` matched to the height so a single digit reads as a disc, not a sliver. */
const COUNTER_DENSITY: Readonly<Record<BadgeDensity, string>> = {
  compact: "h-[18px] min-w-[18px] px-[6px] text-[11px]",
  comfortable: "h-[24px] min-w-[24px] px-[8px] text-[13px]",
};

export interface CounterProps {
  readonly count: number;
  /**
   * A full translated SENTENCE, and required.
   *
   * "12" beside "Pedidos" is meaningless read aloud — twelve what, and is that
   * good? The digits are hidden from assistive technology and this is announced
   * instead ("2 pedidos necesitan una decisión"). It is `sr-only` text rather
   * than an `aria-label` because a counter's home is inside a link, and text
   * folds into that link's accessible name where an `aria-label` on a generic
   * span is only sometimes traversed.
   */
  readonly label: string;
  readonly tone?: CounterTone;
  readonly density?: BadgeDensity;
  readonly className?: string;
}

export function Counter({ count, label, tone = "neutral", density = "comfortable", className }: CounterProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-[var(--r-pill)] font-semibold tabular-nums ${
        COUNTER_DENSITY[density]
      } ${COUNTER_TONE[tone]}${className === undefined ? "" : ` ${className}`}`}
    >
      {/* Rendered raw, not through a number formatter: these are small counts
          of open items, and the sentence beside them is already localised by
          the caller, which is where a grouped thousands separator belongs. */}
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * `match` is the lot code a search just answered; `reference` is a lot code
 * merely being cited. Solid accent for the first, accent tint for the second —
 * the same relationship as a highlighted search term to body text.
 */
export type LotChipVariant = "reference" | "match";

const LOT_VARIANT: Readonly<Record<LotChipVariant, string>> = {
  reference: "bg-[var(--accent-tint)] text-[var(--accent-ink)]",
  match: "bg-[var(--accent)] text-[var(--label-on-accent)]",
};

export interface LotChipProps {
  /** The batch lot code itself, e.g. `B-4471`. */
  readonly code: string;
  readonly variant?: LotChipVariant;
  /**
   * Already-translated word rendered inside the chip before the code — "lote"
   * in Spanish, "lot" in English. A separate text node rather than a
   * caller-built `"lote " + code` so nothing here concatenates translated
   * fragments; omit it where the surrounding row already says what the code is.
   */
  readonly prefix?: string;
  readonly className?: string;
}

/**
 * A batch lot code.
 *
 * Mono at 12px, which is the rule for identifiers and only identifiers: a lot
 * code is compared character by character against a physical tub, and a
 * proportional face makes B/8 and 0/O a coin toss. Money is NOT mono — it gets
 * the sans face with tabular figures.
 *
 * `--r-check` (4px), not `--r-pill`: a pill is a state you read, and this is a
 * value you copy. It is also fixed across densities, where `--r-control` is
 * not, so an inline chip does not turn into a lozenge in the customer area.
 *
 * Not a link, though the artboard draws one: whether a lot code is clickable
 * depends on whether lot search exists on that surface, so the caller wraps it
 * in a `Link` from `@/i18n/navigation` when it is.
 *
 * `inline-block` and not `inline-flex`, which is what the other two capsules
 * use: a chip sits INSIDE a sentence ("×2 · lote B-4402"), so it has to sit on
 * the text baseline — and a flex container drops the whitespace text node
 * between the prefix and the code, which would leave "loteB-4402" as the string
 * a screen reader reads out.
 */
export function LotChip({ code, variant = "reference", prefix, className }: LotChipProps) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-[var(--r-check)] px-[7px] py-[2px] font-mono text-[12px] leading-[16px] ${
        LOT_VARIANT[variant]
      }${className === undefined ? "" : ` ${className}`}`}
    >
      {prefix === undefined ? null : (
        <>
          {prefix}{" "}
        </>
      )}
      {code}
    </span>
  );
}
