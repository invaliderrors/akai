/**
 * The dashboard icon set.
 *
 * WHY THIS FILE EXISTS AT ALL. No icon package is installed, and the artboards
 * draw every glyph as `<img src="https://api.iconify.design/lucide/...">`. Shipped
 * literally, that puts a third-party CDN on the render path of the order list,
 * the invoice screen and the checkout confirmations: a request per glyph, a
 * referrer leak naming the screen the operator is on, and a blank UI the day
 * iconify is slow. The geometry is a few kilobytes of static data, so it lives
 * here instead. `lucide-react` is deliberately NOT a dependency either — it
 * would pull the whole library in to draw forty-eight glyphs.
 *
 * WHY THE NAME IS A CLOSED UNION. `<Icon name="chevorn-right" />` must be a
 * compile error, not a silently empty box in production. Every call site is
 * checked against ICON_NAMES, and adding a glyph is a one-line addition here
 * rather than a string invented at the call site.
 *
 * The path data is lucide's, transcribed verbatim from the same source the
 * artboards point at, so the drawn design and the shipped component are the
 * same geometry. Names are kept in lucide's own kebab-case for that reason: a
 * glyph can be re-fetched or diffed by name without a translation table.
 *
 * Drawn at stroke-width 1.5 rather than lucide's default 2 — the kit is a
 * light, low-contrast surface and a 2px stroke reads as heavy beside 17px body
 * text.
 */

export const ICON_NAMES = [
  // Sidebar and navigation destinations.
  "house", "package", "map-pin", "user", "shield", "undo-2", "chart-line", "tag", "users", "boxes", "percent", "mail", "list-checks", "panel-left",
  // Disclosure and movement.
  "chevron-right", "chevron-left", "chevron-down", "chevrons-up-down", "chevrons-left", "arrow-up-right", "arrow-down-right",
  // Actions.
  "search", "search-x", "x", "check", "plus", "ellipsis", "copy", "download", "share", "trash-2", "eye", "grip-vertical", "sliders-horizontal",
  // Status and feedback.
  "triangle-alert", "circle-alert", "circle-check", "info", "mail-warning", "loader-circle", "lock",
  // Objects the product talks about.
  "banknote", "truck", "shopping-bag", "star", "file-text", "inbox", "calendar",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export interface IconProps {
  readonly name: IconName;
  /**
   * Edge length in CSS pixels.
   *
   * A plain number, not a density token: the landed token layer declares eight
   * density variables and an icon size is not among them, and the artboards
   * draw eleven distinct sizes between 10 and 36 (an 11px inline status glyph,
   * a 16px row icon, a 36px empty-state glyph), so a two-value token could not
   * have covered it. 16 is the compact row default; comfortable rows pass 20.
   */
  readonly size?: number;
  readonly className?: string;
  /**
   * Turns the icon into an image with an accessible name.
   *
   * Omit it — the default — for the overwhelmingly common case where the icon
   * sits beside a visible label and repeating that label to a screen reader is
   * noise. Pass it ONLY when the glyph is the whole control and nothing else
   * names it, and note that on a <button> the button's own aria-label is the
   * better place; a titled icon inside a labelled button announces twice.
   */
  readonly title?: string;
}

/**
 * A single glyph.
 *
 * Colour is always `currentColor`, so an icon inherits the tone of the text it
 * sits in and a caller tints it by setting `text-[var(--danger)]` on the icon or
 * its parent — never by passing a colour in, which is how a raw hex gets back
 * into a component.
 *
 * Server component: pure geometry, no state, no handlers.
 */
export function Icon({ name, size = 16, className, title }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      // Round caps are load-bearing, not decoration: several glyphs draw their
      // dots as a zero-length segment (`h.01`), which paints nothing at all
      // under the default butt cap.
      strokeLinecap="round"
      strokeLinejoin="round"
      // `shrink-0` because the usual home for an icon is a flex row next to a
      // label that can be long; without it the glyph is the thing that gets
      // squashed, and a squashed 16px icon looks like a rendering bug.
      className={className === undefined ? "shrink-0" : `shrink-0 ${className}`}
      {...(title === undefined ? { "aria-hidden": true } : { role: "img" as const })}
    >
      {title === undefined ? null : <title>{title}</title>}
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * Path data, keyed by name.
 *
 * `Record<IconName, ...>` in both directions: a name in ICON_NAMES with no
 * geometry here fails to compile, and geometry here for a name that is not in
 * ICON_NAMES is rejected as an excess property. The two lists cannot drift.
 *
 * Everything is stroked path data — lucide's `<circle>` and `<rect>` children
 * are pre-converted to arcs and rounded-rectangle paths so that one `<path>`
 * loop renders every glyph, and `tag`'s filled dot is drawn with the same
 * `h.01` round-cap idiom lucide itself uses for the dots in `circle-alert`,
 * `triangle-alert` and `banknote`, rather than being the one filled shape in
 * the set.
 */
const ICON_PATHS: Readonly<Record<IconName, readonly string[]>> = {
  // Sidebar and navigation destinations.
  "house": [
    "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",
    "M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  ],
  "package": [
    "M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73zm1 .27V12",
    "M3.29 7L12 12l8.71-5M7.5 4.27l9 5.15",
  ],
  "map-pin": [
    "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0",
    "M9 10a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
  ],
  "user": [
    "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",
    "M8 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
  ],
  "shield": ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"],
  "undo-2": [
    "M9 14L4 9l5-5",
    "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11",
  ],
  "chart-line": [
    "M3 3v16a2 2 0 0 0 2 2h16",
    "m19 9l-5 5l-4-4l-3 3",
  ],
  "tag": [
    "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z",
    "M7.5 7.5h.01",
  ],
  "users": [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.128a4 4 0 0 1 0 7.744M22 21v-2a4 4 0 0 0-3-3.87",
    "M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
  ],
  "boxes": [
    "M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3zM7 16.5l-4.74-2.85M7 16.5l5-3m-5 3v5.17m5-8.17V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5zm5 3l-5-3m5 3l4.74-2.85M17 16.5v5.17",
    "M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3l5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0zM12 8L7.26 5.15M12 8l4.74-2.85M12 13.5V8",
  ],
  "percent": [
    "M19 5L5 19",
    "M4 6.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",
    "M15 17.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",
  ],
  "mail": [
    "m22 7l-8.991 5.727a2 2 0 0 1-2.009 0L2 7",
    "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z",
  ],
  "list-checks": ["M13 5h8m-8 7h8m-8 7h8M3 17l2 2l4-4M3 7l2 2l4-4"],
  "panel-left": [
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z",
    "M9 3v18",
  ],
  // Disclosure and movement.
  "chevron-right": ["m9 18l6-6l-6-6"],
  "chevron-left": ["m15 18l-6-6l6-6"],
  "chevron-down": ["m6 9l6 6l6-6"],
  "chevrons-up-down": ["m7 15l5 5l5-5M7 9l5-5l5 5"],
  "chevrons-left": ["m11 17l-5-5l5-5m7 10l-5-5l5-5"],
  "arrow-up-right": ["M7 7h10v10M7 17L17 7"],
  "arrow-down-right": ["m7 7l10 10m0-10v10H7"],
  // Actions.
  "search": [
    "m21 21l-4.34-4.34",
    "M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0",
  ],
  "search-x": [
    "m13.5 8.5l-5 5m0-5l5 5",
    "M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0",
    "m21 21l-4.3-4.3",
  ],
  "x": ["M18 6L6 18M6 6l12 12"],
  "check": ["M20 6L9 17l-5-5"],
  "plus": ["M5 12h14m-7-7v14"],
  "ellipsis": [
    "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  ],
  "copy": [
    "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z",
    "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
  ],
  "download": [
    "M12 15V3m9 12v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
    "m7 10l5 5l5-5",
  ],
  "share": ["M12 2v13m4-9l-4-4l-4 4m-4 6v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"],
  "trash-2": ["M10 11v6m4-6v6m5-11v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  "eye": [
    "M2.062 12.348a1 1 0 0 1 0-.696a10.75 10.75 0 0 1 19.876 0a1 1 0 0 1 0 .696a10.75 10.75 0 0 1-19.876 0",
    "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
  ],
  "grip-vertical": [
    "M8 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M8 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M8 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M14 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M14 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M14 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  ],
  "sliders-horizontal": ["M10 5H3m9 14H3M14 3v4m2 10v4m5-9h-9m9 7h-5m5-14h-7m-6 5v4m0-2H3"],
  // Status and feedback.
  "triangle-alert": ["m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"],
  "circle-alert": [
    "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
    "M12 8v4m0 4h.01",
  ],
  "circle-check": [
    "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
    "m16 9l-5.5 5.5L8 12",
  ],
  "info": [
    "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
    "M12 16v-4m0-4h.01",
  ],
  "mail-warning": [
    "M22 10.5V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h12.5",
    "m22 7l-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7m18 7v4m0 4v.01",
  ],
  "loader-circle": ["M21 12a9 9 0 1 1-6.219-8.56"],
  "lock": [
    "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2z",
    "M7 11V7a5 5 0 0 1 10 0v4",
  ],
  // Objects the product talks about.
  "banknote": [
    "M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2z",
    "M10 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M6 12h.01M18 12h.01",
  ],
  "truck": [
    "M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2m10 0H9m10 0h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14",
    "M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
  ],
  "shopping-bag": [
    "M16 10a4 4 0 0 1-8 0M3.103 6.034h17.794",
    "M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z",
  ],
  "star": ["M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16z"],
  "file-text": [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8",
  ],
  "inbox": [
    "M22 12h-6l-2 3h-4l-2-3H2",
    "M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11",
  ],
  "calendar": [
    "M8 2v3m8-3v3",
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z",
    "M3 9h18",
  ],
};
