import type { DailyRevenuePoint } from "@/lib/admin/schemas";

/**
 * The daily gross-revenue line, drawn as static inline SVG.
 *
 * NO CHARTING LIBRARY. Eight-ish points a day for a 90-day window is a
 * polyline with at most 90 vertices — reaching for a dependency to draw that
 * would be the same mistake `icon.tsx` already refused to make for forty-eight
 * glyphs. The geometry here is display-only and never the input to arithmetic,
 * matching every other aggregate on this page.
 *
 * `role="img"` with a `<title>`, exactly `Icon`'s pattern: a chart is content,
 * not decoration, so it gets an accessible name rather than `aria-hidden`.
 *
 * No `"use client"`: the series is fetched server-side and handed down as
 * props, and nothing here has state, an effect or a handler.
 */

export interface RevenueChartProps {
  readonly points: readonly DailyRevenuePoint[];
  /** The chart's accessible name — already translated and already specific. */
  readonly label: string;
  readonly className?: string;
}

const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 120;
/** Keeps the line off the very top/bottom edge so a flat series still reads as a line, not a rectangle's border. */
const INSET = 6;

function buildPath(points: readonly DailyRevenuePoint[]): string {
  const max = Math.max(...points.map((point) => point.grossTotal));
  const usableHeight = VIEW_HEIGHT - INSET * 2;
  const stepX = points.length > 1 ? (VIEW_WIDTH - INSET * 2) / (points.length - 1) : 0;

  const coords = points.map((point, index) => {
    const x = INSET + index * stepX;
    // A flat-zero series (a genuinely quiet window) draws a flat line at the
    // BOTTOM, not a division-by-zero NaN path — `max === 0` is the one case
    // where "no revenue" and "no data" would otherwise look identical.
    const y =
      max === 0 ? VIEW_HEIGHT - INSET : VIEW_HEIGHT - INSET - (point.grossTotal / max) * usableHeight;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return coords.join(" L");
}

/** Two points is the fewest a line means anything for; the caller renders an empty state below that. */
export const MIN_CHART_POINTS = 2;

export function RevenueChart({ points, label, className }: RevenueChartProps) {
  if (points.length < MIN_CHART_POINTS) {
    return null;
  }

  const path = `M${buildPath(points)}`;

  return (
    <svg
      role="img"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      className={`h-[120px] w-full text-[var(--accent)]${
        className === undefined ? "" : ` ${className}`
      }`}
    >
      <title>{label}</title>
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
