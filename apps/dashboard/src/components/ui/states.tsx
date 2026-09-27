"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { ErrorCode } from "@akai/contracts";

import { buttonClassName } from "./button";
import { Icon, type IconName } from "./icon";

/**
 * The three states a data-backed view owes its reader: nothing here, it broke,
 * it is coming.
 *
 * ONE OF EACH, AND THE COUNT IS THE POINT. Before this file the dashboard held
 * two empty states (`account/states.tsx` and the admin primitives module) and
 * three error states (those two plus `admin/admin-error-state.tsx`), each with its
 * own padding, its own red and its own opinion about whether a request id is
 * worth showing. A customer who fails on their orders page and an operator who
 * fails on the products table were looking at two different products.
 *
 * WHY THIS FILE IS `"use client"`. `ErrorState` writes the request id to the
 * clipboard and holds a two-second "copied" flag — a browser API and a piece of
 * state, so it cannot be a server component. The directive is file-scoped, so
 * `EmptyState` and `Skeleton` ride along; that is the price of the plan's "one
 * file, three states", and it is a few hundred bytes on a page that was already
 * shipping a cart of React.
 *
 * Everything user-visible arrives already translated EXCEPT the error's cause,
 * which is resolved here from the `errors` namespace keyed by the closed
 * `ErrorCode` enum — see `ErrorState`.
 */

/**
 * Where the state is standing.
 *
 * `page` is a whole view giving itself over to the message; `table` is the
 * body of a list whose column headings stay on screen above it, so it has to
 * be quieter or it shouts over the chrome that is still there. Two sizes of the
 * same thing, not two components.
 */
export type StateDensity = "page" | "table";

interface DensitySpec {
  readonly padding: string;
  readonly gap: string;
  readonly glyph: number;
  readonly titleGap: string;
  readonly title: string;
  readonly body: string;
  /** Character cap on the body. Prose wider than this stops being scannable. */
  readonly measure: string;
  readonly actions: string;
}

const DENSITY: Readonly<Record<StateDensity, DensitySpec>> = {
  page: {
    padding: "px-6 py-10",
    gap: "gap-2",
    glyph: 36,
    titleGap: "mt-1.5",
    // The drawn -0.45px tracking, not a Tailwind step: at 20px the built-in
    // `tracking-tight` (-0.025em = -0.5px) is close but the display face is
    // already tight and the extra half-pixel closes the counters.
    title: "text-[20px] font-semibold tracking-[-0.45px]",
    body: "text-[15px]",
    measure: "max-w-[30ch]",
    actions: "mt-2",
  },
  table: {
    padding: "px-6 py-9",
    gap: "gap-1.5",
    glyph: 28,
    titleGap: "mt-1",
    title: "text-[15px] font-semibold",
    body: "text-[13px]",
    // Wider measure at the smaller size: 34ch of 13px text is physically
    // narrower than 30ch of 15px, so the line length stays comparable.
    measure: "max-w-[34ch]",
    actions: "mt-1.5",
  },
};

const FRAME = "grid justify-items-center text-center";

/**
 * Which kind of nothing this is.
 *
 * `nothing-yet` is a state of the world — the account is new, the shelf is
 * bare — and the right response is a way to start. `no-matches` is a state of
 * the QUERY, and the right response is to loosen it. Rendering the same glyph
 * for both tells a customer who has just typo'd a search that they have never
 * placed an order.
 */
export type EmptyReason = "nothing-yet" | "no-matches";

/**
 * `inbox` rather than the artboard's `package` for the default: the drawing
 * uses `package` for an ORDERS list and `inbox` for its English twin, i.e. the
 * two are interchangeable at this size and tint, and `inbox` is the one that is
 * not already a parcel. A domain surface passes its own — `package` for orders,
 * `tag` for discounts — through `icon`.
 */
const REASON_GLYPH: Readonly<Record<EmptyReason, IconName>> = {
  "nothing-yet": "inbox",
  "no-matches": "search-x",
};

export interface EmptyStateProps {
  /** Already translated. A statement, not a heading — see the note below. */
  readonly title: string;
  readonly body: string;
  readonly reason?: EmptyReason;
  /** Overrides the reason's glyph where the domain has a better one. */
  readonly icon?: IconName;
  readonly density?: StateDensity;
  /**
   * The way out. At `page` density the drawn control is a 36px prominent
   * button (`<Button variant="prominent" size="comfortable">`); in a table it
   * is a 28px standard one, because "Limpiar filtros" is a correction, not the
   * thing the screen is for.
   */
  readonly action?: ReactNode;
  readonly className?: string;
}

/**
 * A legitimately empty region.
 *
 * THE TITLE IS A `<p>`, NOT A HEADING, and deliberately so: this thing appears
 * inside a card that a `SectionHeader` has already named and inside tables that
 * sit under an `<h1>`. Emitting an `<h2>` here would push a rung into the
 * document outline that exists only when a list happens to be empty, so the
 * outline a screen-reader user navigates would change shape with the data.
 */
export function EmptyState({
  title,
  body,
  reason = "nothing-yet",
  icon,
  density = "page",
  action,
  className,
}: EmptyStateProps) {
  const spec = DENSITY[density];

  return (
    <div
      className={`${FRAME} ${spec.gap} ${spec.padding}${className === undefined ? "" : ` ${className}`}`}
    >
      <Icon
        name={icon ?? REASON_GLYPH[reason]}
        size={spec.glyph}
        className="text-[var(--label-tertiary)]"
      />
      <p className={`${spec.titleGap} ${spec.title} text-[var(--label)]`}>{title}</p>
      <p className={`${spec.body} ${spec.measure} text-[var(--label-secondary)]`}>{body}</p>
      {action === undefined ? null : <div className={spec.actions}>{action}</div>}
    </div>
  );
}

/**
 * Who is reading the failure.
 *
 * The whole difference between the two variants is one question: can this
 * person do anything with a string the API wrote? An operator can — "502
 * upstream timeout · orders-projection" is the fastest route from a screen to a
 * log line. A customer cannot: it is English, it names internal services, and
 * it is written for whoever is on call.
 */
export type ErrorAudience = "customer" | "admin";

export interface ErrorStateProps {
  /** What failed, in the page's own words. Already translated. */
  readonly title: string;
  /**
   * The platform's machine-readable code. The cause sentence is looked up from
   * the `errors` namespace against this CLOSED enum — never from
   * `ApiError.message`, which is a log line that happens to be in English.
   *
   * Deliberately the bare code rather than the whole `ApiError`: a primitive in
   * `ui/` that imported the api client's types would make every future consumer
   * of this component reach through `lib/api` to render a box.
   */
  readonly code: ErrorCode;
  /** Quotable to support. `null` for a failure that never reached the API. */
  readonly requestId: string | null;
  readonly audience?: ErrorAudience;
  /**
   * The upstream's own words. Rendered ONLY when `audience` is `"admin"`, in a
   * mono chip; on the customer variant it is accepted and dropped, so a page
   * that hands the same props to both cannot leak it by forgetting a branch.
   */
  readonly detail?: string;
  readonly density?: StateDensity;
  /** The retry control, already translated. Drawn prominent in both densities. */
  readonly action?: ReactNode;
  /**
   * Accessible name for the request-id button. Defaults to the reference
   * sentence itself ("Referencia: req_8f21…"), which says what the value IS;
   * pass a verb ("Copiar la referencia") once a `ui` namespace exists to hold
   * one.
   */
  readonly copyLabel?: string;
  readonly className?: string;
}

/**
 * A failed region.
 *
 * `role="alert"` on the container, and exactly one per region: the alert is the
 * whole box, so the title, the cause and the reference are announced as one
 * thought rather than as three arrivals.
 */
export function ErrorState({
  title,
  code,
  requestId,
  audience = "customer",
  detail,
  density = "page",
  action,
  copyLabel,
  className,
}: ErrorStateProps) {
  const t = useTranslations("errors");
  const spec = DENSITY[density];

  // The same fallback `ui/alert.tsx` uses, and for the same reason: `errors`
  // holds a leaf for every current `ErrorCode`, but a code added to the
  // contract before the catalogues catch up must degrade to the generic
  // sentence rather than render next-intl's missing-key marker at a customer.
  // `states.test.tsx` walks `errorCodeSchema.options` so that window is loud.
  const cause = t.has(code) ? t(code) : t("generic");

  // An operator's raw string REPLACES the translated cause rather than joining
  // it. Two sentences saying the same thing at different levels of abstraction
  // is how an error box grows to five lines nobody reads; the code is still
  // there, in the reference, one click from the log.
  const upstream = audience === "admin" && detail !== undefined && detail !== "" ? detail : null;

  return (
    <div
      role="alert"
      className={`${FRAME} ${spec.gap} ${spec.padding}${className === undefined ? "" : ` ${className}`}`}
    >
      {/* `--danger`, the indicator red, not `--danger-text`: this glyph paints
          on the page's own background and never carries text. */}
      <Icon name="circle-alert" size={spec.glyph} className="text-[var(--danger)]" />
      <p className={`${spec.titleGap} ${spec.title} text-[var(--label)]`}>{title}</p>
      {upstream === null ? (
        <p className={`${spec.body} ${spec.measure} text-[var(--label-secondary)]`}>{cause}</p>
      ) : (
        <p
          className={`${spec.measure} rounded-[var(--r-check)] bg-[var(--bg-grouped)] px-2 py-[5px] font-mono text-[11px] break-words text-[var(--neutral-text)]`}
        >
          {upstream}
        </p>
      )}
      {requestId === null || requestId === "" ? (
        // "Referencia:" with nothing after it is worse than showing nothing:
        // it invites a support conversation that starts with a blank.
        action === undefined ? null : (
          <div className={spec.actions}>{action}</div>
        )
      ) : (
        <div className={`${spec.actions} flex flex-wrap items-center justify-center gap-2`}>
          <RequestIdButton
            requestId={requestId}
            density={density}
            {...(copyLabel === undefined ? {} : { label: copyLabel })}
          />
          {action}
        </div>
      )}
    </div>
  );
}

/** How long the copy confirmation holds before the glyph goes back. */
const COPIED_MS = 2000;

interface RequestIdButtonProps {
  readonly requestId: string;
  readonly density: StateDensity;
  readonly label?: string;
}

/**
 * The request id, as a control rather than as a string to transcribe.
 *
 * THERE IS NO SPOKEN "COPIED" CONFIRMATION, and that is a decision rather than
 * an omission: this button lives inside a `role="alert"`, and a live region
 * nested in an assertive one re-announces the entire failure every time
 * somebody presses copy. A glyph swap is the honest trade — a sighted user gets
 * feedback, and nobody gets the error read to them twice.
 */
function RequestIdButton({ requestId, density, label }: RequestIdButtonProps) {
  const t = useTranslations("errors");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  const handleCopy = () => {
    // The DOM lib types `navigator.clipboard` as always present; jsdom and any
    // non-secure context disagree. Read it through a nullable local rather than
    // asserting it, so a test render and an http:// preview do not throw.
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) return;
    void clipboard.writeText(requestId).then(
      () => {
        setCopied(true);
      },
      () => {
        // A denied clipboard permission is not worth an error state of its own;
        // the id is on screen and selectable either way.
        setCopied(false);
      },
    );
  };

  return (
    <button
      type="button"
      aria-label={label ?? t("requestId", { id: requestId })}
      onClick={handleCopy}
      // `buttonClassName` rather than `<Button>`: this control needs an
      // `aria-label` that differs from its visible text, which `Button` does
      // not expose — and the class function exists precisely to be the seam for
      // a host element the component set does not draw.
      className={buttonClassName({
        variant: "standard",
        size: density === "page" ? "comfortable" : "compact",
        leadingIcon: true,
        className: `font-mono ${density === "page" ? "text-[13px]" : "text-[12px]"}`,
      })}
    >
      <Icon name={copied ? "check" : "copy"} size={density === "page" ? 14 : 12} />
      {requestId}
    </button>
  );
}

/**
 * The shape of the thing that is loading.
 *
 * `text` is bare bars for a placeholder inside a surface that is already
 * drawn; `card` brings its own white panel; `rows` is a list or table body,
 * whose bars take `--row-h` so the skeleton is exactly as tall as the content
 * that replaces it and the page does not jump when it arrives.
 */
export type SkeletonVariant = "text" | "card" | "rows";

export interface SkeletonProps {
  /** Already translated, and specific where it can be ("Cargando pedidos…"). */
  readonly label?: string;
  readonly variant?: SkeletonVariant;
  readonly rows?: number;
  readonly className?: string;
}

const SKELETON_FRAME: Readonly<Record<SkeletonVariant, string>> = {
  text: "grid gap-2.5",
  card: "grid gap-2.5 rounded-[var(--r-card)] bg-[var(--bg-grouped-secondary)] p-5",
  rows: "grid gap-2",
};

/**
 * Bar geometry, as class names rather than as numbers.
 *
 * Tailwind v4 finds utilities by scanning source TEXT, so a width computed at
 * runtime is a class that is never generated — no error, just a bar with no
 * width. Returning the literal from a total `switch` keeps every value visible
 * to the scanner AND avoids indexing an array, which under
 * `noUncheckedIndexedAccess` would need a fallback branch that can never run.
 */
function barWidth(variant: SkeletonVariant, index: number): string {
  if (variant === "rows") return "w-full";
  switch (index % 3) {
    case 0:
      return "w-[40%]";
    case 1:
      return "w-[55%]";
    default:
      return "w-[70%]";
  }
}

function barHeight(variant: SkeletonVariant, index: number): string {
  if (variant === "rows") return "h-[var(--row-h)]";
  // The second bar stands in for a title. A stack of identical bars reads as a
  // paragraph, and the eye does not expect a heading to appear in one.
  return index === 1 ? "h-[26px]" : "h-3";
}

/**
 * A loading region.
 *
 * THE BARS ARE `aria-hidden` AND THERE IS EXACTLY ONE `role="status"`. A
 * skeleton that says nothing reads to a screen reader as an empty page, which
 * is indistinguishable from "you have no orders" — the precise confusion this
 * whole file exists to prevent. One announcement, not one per bar: five polite
 * interruptions saying "Cargando…" is worse than none.
 *
 * `aria-busy` marks the container rather than the announcement, so the region
 * is flagged in-progress while the live region that carries the words is its
 * own root and is not deferred by it.
 *
 * ONLY THE FIRST BAR ANIMATES. The artboard sweeps a gradient across it; a
 * keyframe cannot be added here (globals.css is owned elsewhere), so this uses
 * the built-in pulse, which the reduced-motion blanket in that file already
 * clamps. One moving element is a heartbeat; six is a strobe.
 */
export function Skeleton({ label, variant = "text", rows = 3, className }: SkeletonProps) {
  const t = useTranslations("common");
  // A zero-bar skeleton is an announcement with nothing under it, which looks
  // to a sighted user exactly like the empty page this component prevents.
  const count = Math.max(1, rows);

  return (
    <div
      aria-busy="true"
      className={`${SKELETON_FRAME[variant]}${className === undefined ? "" : ` ${className}`}`}
    >
      <span role="status" className="sr-only">
        {label ?? t("loading")}
      </span>
      {Array.from({ length: count }, (_unused, index) => (
        <span
          key={index}
          aria-hidden
          className={`block rounded-[var(--r-check)] bg-[var(--fill-tertiary)] ${barHeight(
            variant,
            index,
          )} ${barWidth(variant, index)}${index === 0 ? " animate-pulse" : ""}`}
        />
      ))}
    </div>
  );
}
