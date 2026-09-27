import type { StatusDomain } from "@/lib/status";
import { StatusBadge } from "@/components/ui/status-badge";

/**
 * One status's count, drawn as a badge, a tally and a proportion bar.
 *
 * Extracted from the admin overview's orders-by-status card once returns and
 * email delivery grew the same shape: a badge (so the raw enum member never
 * reaches an operator — see `StatusBadge`), a count and a bar showing that
 * count's share of the total. Three near-identical copies of that markup is
 * exactly the drift `StatusBadge` itself was written to close one level up.
 *
 * No `"use client"`: props in, markup out.
 */

export interface StatusBreakdownEntry {
  readonly status: string;
  readonly count: number;
}

export interface StatusBreakdownProps {
  readonly domain: StatusDomain;
  readonly entries: readonly StatusBreakdownEntry[];
  /** Already grouped for the reader's locale, e.g. `Intl.NumberFormat.format`. */
  readonly formatCount: (count: number) => string;
  /**
   * True for the one status whose bar should draw in the attention colour —
   * the mismatch row in the orders breakdown. Absent everywhere else: a
   * returns or email breakdown has no status that means "something is wrong
   * with the SYSTEM" the way a payment mismatch does.
   */
  readonly emphasize?: (status: string) => boolean;
}

/** One status's share of the total, as a percentage. */
function share(count: number, total: number): number {
  // Unreachable while `entries` is non-empty (a status with no rows has no
  // entry), but a division that can produce NaN must not depend on a caller's
  // discipline — NaN reaches the DOM as `width: NaN%`, which is dropped, and a
  // missing bar looks exactly like a zero one.
  return total === 0 ? 0 : (count / total) * 100;
}

export function StatusBreakdown({
  domain,
  entries,
  formatCount,
  emphasize,
}: StatusBreakdownProps) {
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);

  return (
    // `role="list"` is not redundant: Tailwind's preflight removes the list
    // style, and Safari + VoiceOver then drop the role.
    <ul
      role="list"
      className="m-0 grid list-none gap-x-6 gap-y-2.5 p-0 sm:grid-cols-2 lg:grid-cols-3"
    >
      {entries.map((entry) => (
        <li
          key={entry.status}
          className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1"
        >
          <StatusBadge
            domain={domain}
            value={entry.status}
            density="compact"
            className="justify-self-start"
          />
          <span className="text-[13px] font-semibold tabular-nums text-[var(--label)]">
            {formatCount(entry.count)}
          </span>
          {/*
            The proportion, drawn rather than stated. `aria-hidden` because the
            count beside it is the same fact in words. The width is an INLINE
            STYLE and has to be: Tailwind finds utilities by scanning source
            text, so a `w-[${percent}%]` computed at runtime is a class that is
            never generated — no error, just a bar with no width. The colour
            stays a token.
          */}
          <span
            aria-hidden
            className="col-span-2 h-1 overflow-hidden rounded-[var(--r-check)] bg-[var(--fill-tertiary)]"
          >
            <span
              className={`block h-full rounded-[var(--r-check)] ${
                emphasize?.(entry.status) === true
                  ? "bg-[var(--danger)]"
                  : "bg-[var(--fill-quaternary)]"
              }`}
              style={{ width: `${share(entry.count, total)}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
