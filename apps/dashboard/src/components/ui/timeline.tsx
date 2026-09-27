import { useTranslations } from "next-intl";

import { messageKey } from "@/lib/status";

import { Icon, type IconName } from "./icon";
import { NoteComposer, type TimelineComposer } from "./timeline-composer";

/**
 * The order event rail: what happened to this order, when, and — the part this
 * component exists for — WHO CAN SEE IT.
 *
 * INTERNAL NOTES MUST NOT LOOK LIKE CUSTOMER-VISIBLE EVENTS. `orderEvent`
 * carries `isInternal: boolean` (commerce.ts:152-161) and the current admin
 * screen renders both halves identically, so the only thing separating "the
 * customer read this" from "we wrote this about the customer" is an operator's
 * memory of which line they typed. That is how an internal note gets pasted
 * into a reply. Here an internal entry takes a `--warning-fill` card, a lock in
 * its node, warning ink on its heading and the words "Solo operadores" beside
 * the type — four signals, only one of which is colour (WCAG 1.4.1) — and a
 * customer-visible entry says "Visible para el cliente" in its own words. The
 * caller cannot turn any of that off: `tone` and `icon` are IGNORED on an
 * internal entry, so no call site can dress one down.
 *
 * THIS IS AN OPERATOR SURFACE, AND THE CONTRACT IS WHY. `orderEventSchema.type`
 * and `.message` are open `z.string()` — there is no enum behind either, so
 * there is no closed set of members to key a translation off and nothing here
 * can be translated without inventing a mapping that the API is free to
 * contradict on its next deploy. So the server's strings are rendered VERBATIM,
 * which is honest for an admin reading operational English and would be a
 * defect on a customer-facing screen. Closing `type` to an enum in
 * `libs/contracts` is the change that unlocks translation: this component would
 * then take a member and resolve it the way `status-badge.tsx` resolves a
 * status, and `message` would become structured data rather than prose. Until
 * then, do not mount this on a customer route.
 *
 * The two VISIBILITY labels are the exception, and they are translated: they
 * are ours, not the API's, and they already live in the closed `internalNote`
 * vocabulary in `lib/status` (`status.internalNote.internal` /
 * `.customer`, present in both catalogues). They are read here rather than
 * taken as props precisely because they are the safety property — a prop could
 * be passed an empty string, and then an internal note is a beige box nobody
 * has to explain.
 *
 * WHY THERE IS NO `"use client"` DIRECTIVE. `Timeline` is props in, markup out,
 * so a read-only rail renders inside a server component with no JavaScript at
 * all — which is how the order detail page renders it.
 *
 * The composer that writes an internal note holds a draft in `useState`, and it
 * lives in `timeline-composer.tsx` behind its own directive. It used to live
 * here, on the reasoning that a component requiring an `onSubmit` function is
 * unreachable from a server tree anyway. That is true at runtime and irrelevant
 * at build time: Next's check is static and module-level, so importing this file
 * from a server component failed the build on the `useState` import alone. The
 * boundary now sits where the state does.
 */

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * The five tones with a `--*-fill` tint and a matching indicator.
 *
 * `attention` from `BadgeTone` is deliberately NOT here: it is a solid red fill
 * whose budget is exactly two uses in the product (`lib/status` asserts the
 * cap), and it has no tint to make a 20px node out of. An event that is truly
 * alarming is `danger`.
 */
export type TimelineTone = "neutral" | "progress" | "success" | "warning" | "danger";

const NODE: Readonly<Record<TimelineTone, string>> = {
  neutral: "bg-[var(--neutral-fill)] text-[var(--neutral)]",
  progress: "bg-[var(--progress-fill)] text-[var(--progress)]",
  success: "bg-[var(--success-fill)] text-[var(--success)]",
  warning: "bg-[var(--warning-fill)] text-[var(--warning)]",
  danger: "bg-[var(--danger-fill)] text-[var(--danger)]",
};

export interface TimelineEntry {
  readonly id: string;
  /**
   * `orderEvent.type`, rendered verbatim as the entry's heading.
   *
   * Open `z.string()` in the contract, so it is whatever the API wrote —
   * operator English, not copy. See the file header.
   */
  readonly type: string;
  /** `orderEvent.message`, also verbatim and also untranslatable today. */
  readonly message: string;
  /** Drives the whole visibility treatment. Never inferred from `type`. */
  readonly isInternal: boolean;
  /** ISO 8601, straight off the wire — the machine-readable half of `<time>`. */
  readonly createdAt: string;
  /**
   * The human half, already localised by the caller ("29 ago, 09:14").
   *
   * Two fields rather than one because a date is the one value on this rail
   * that MUST be formatted in the reader's locale, and a primitive that
   * formatted it would need its own `Intl.DateTimeFormat` opinion beside the
   * three the app already has.
   */
  readonly timestamp: string;
  /** Ignored on an internal entry, which is always `warning`. */
  readonly tone?: TimelineTone;
  /**
   * Ignored on an internal entry, which is always `lock`.
   *
   * Optional because `type` is an open string: this component cannot map an
   * unknown member to a glyph, and guessing would put a truck on a refund. A
   * caller that recognises the type passes the right one; everything else gets
   * `info`, which claims nothing.
   */
  readonly icon?: IconName;
}

interface TimelineItemProps {
  readonly entry: TimelineEntry;
  /** False on the last entry — a rail into empty space is a promise of more. */
  readonly hasRail: boolean;
  /** Already translated, and picked by `isInternal` in one place upstream. */
  readonly visibility: string;
}

function TimelineItem({ entry, hasRail, visibility }: TimelineItemProps) {
  // The forcing, in two lines: an internal note is warning-toned and locked
  // whatever the caller passed. This is the safety property of the component,
  // so it is not a default that a prop can override.
  const tone: TimelineTone = entry.isInternal ? "warning" : (entry.tone ?? "neutral");
  const glyph: IconName = entry.isInternal ? "lock" : (entry.icon ?? "info");

  return (
    <li className={`relative grid grid-cols-[20px_1fr] gap-2.5${hasRail ? " pb-3.5" : ""}`}>
      {/* Starts at the node's bottom edge and runs to the row's, so the gap
          between two nodes is bridged exactly. Drawn as an absolute span rather
          than a border on the row: a border would sit on the box, and the rail
          has to be centred on a 20px circle in column one. */}
      {hasRail ? (
        <span
          aria-hidden
          className="absolute top-5 bottom-0 left-[9px] w-[2px] bg-[var(--fill-tertiary)]"
        />
      ) : null}

      <span
        className={`relative z-[1] inline-flex h-5 w-5 items-center justify-center rounded-full ${NODE[tone]}`}
      >
        {/* Decorative: the heading beside it says what happened, and on an
            internal note the words "Solo operadores" say what the lock means. */}
        <Icon name={glyph} size={11} />
      </span>

      <div
        className={
          entry.isInternal
            ? // 8px, a literal. The card is nested inside a `--r-card` (10px)
              // surface and the concentric rule wants the inner radius smaller
              // at every density; `--r-control` swings 6 → 10 and would equal
              // the outer one in a comfortable shell. The token layer ships no
              // nested-card radius, and globals.css is owned elsewhere.
              "rounded-[8px] bg-[var(--warning-fill)] px-2.5 py-2"
            : ""
        }
      >
        <div className="flex flex-wrap justify-between gap-2">
          <span
            className={`text-[12px] leading-4 font-semibold ${
              entry.isInternal ? "text-[var(--warning-text)]" : "text-[var(--label)]"
            }`}
          >
            {entry.type}
            {entry.isInternal ? (
              <>
                {" · "}
                <span>{visibility}</span>
              </>
            ) : null}
          </span>

          {/*
            NOT MONO, though the artboard draws it so. Mono in this system is
            for IDENTIFIERS — order numbers, SKUs, lot codes, request ids —
            things compared character by character; a timestamp is compared by
            position in a column, and `tabular-nums` on the sans face gives the
            digits a common width without making every event read as code. Same
            call `money.tsx` records for amounts.
          */}
          <time
            dateTime={entry.createdAt}
            className="text-[11px] leading-4 tabular-nums text-[var(--label-secondary)]"
          >
            {entry.timestamp}
          </time>
        </div>

        <p
          className={`m-0 mt-[3px] text-[12px] leading-[1.4] ${
            entry.isInternal ? "text-[var(--label)]" : "text-[var(--neutral-text)]"
          }`}
        >
          {entry.message}
          {/* The quiet half of the pair. An internal note shouts in its heading
              because it is the exception; repeating "Visible para el cliente"
              at that weight on the other nine entries would be the noise that
              makes the exception blend in. It is still text, still on every
              entry, and still the same vocabulary. */}
          {entry.isInternal ? null : (
            <>
              {/* The separator sits OUTSIDE the span so the span's text is
                  exactly the vocabulary's own words — a middot folded into it
                  makes the label unqueryable by name and reads as punctuation
                  attached to the phrase. */}
              {entry.message === "" ? null : " · "}
              <span className="text-[var(--label-secondary)]">{visibility}</span>
            </>
          )}
        </p>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

interface TimelineBase {
  /** Newest first is the caller's ordering decision; this renders them as given. */
  readonly entries: readonly TimelineEntry[];
  /** Omit it for a read-only rail — which is then a server component. */
  readonly composer?: TimelineComposer;
  readonly className?: string;
}

/**
 * Exactly one of `label` (an accessible name for the list) or `labelledBy` (an
 * id of a heading the caller already rendered — the `Card` title above it,
 * normally), or neither. A union rather than two optionals, so the list cannot
 * be given two names and announce whichever the browser preferred.
 *
 * Unlike `GroupedList`, `label` does NOT render a visible header: a timeline's
 * home is inside a titled card, and a second heading immediately under the
 * card's own would be the same words twice.
 */
export type { TimelineComposer };

export type TimelineProps = TimelineBase &
  (
    | { readonly label: string; readonly labelledBy?: undefined }
    | { readonly labelledBy: string; readonly label?: undefined }
    | { readonly label?: undefined; readonly labelledBy?: undefined }
  );

export function Timeline({ entries, composer, label, labelledBy, className }: TimelineProps) {
  // Root namespace, matching `status-badge.tsx`: `messageKey` builds the full
  // path, so the namespace and the domain are joined in exactly one place.
  const t = useTranslations();
  const internalLabel = t(messageKey("internalNote", "internal"));
  const customerLabel = t(messageKey("internalNote", "customer"));

  const lastIndex = entries.length - 1;

  return (
    <div className={className}>
      <ol
        // `role="list"` is not redundant here: Tailwind's preflight sets
        // `list-style: none`, and Safari + VoiceOver drop the list role from an
        // unstyled list — which is exactly the semantics a rail of events is
        // for. Same reasoning as `grouped-list.tsx`.
        role="list"
        className="m-0 grid list-none p-0"
        {...(label === undefined ? {} : { "aria-label": label })}
        {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      >
        {entries.map((entry, index) => (
          <TimelineItem
            key={entry.id}
            entry={entry}
            hasRail={index < lastIndex}
            visibility={entry.isInternal ? internalLabel : customerLabel}
          />
        ))}
      </ol>

      {composer === undefined ? null : <NoteComposer {...composer} />}
    </div>
  );
}
