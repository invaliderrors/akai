import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * REGRESSION: the HIG role tokens are ADDITIVE, and the legacy block they sit
 * beside is load-bearing for screens nothing in the redesign touches.
 *
 * `app/[locale]/(auth)/` holds five page directories and no layout, so the auth
 * screens render outside DashboardShell. They are styled entirely by the legacy
 * semantic classes (.btn, .input, .field, .alert, .auth__*), which read the
 * legacy `:root` properties. Retiring one of those names — or one of those
 * classes — changes five screens that no diff would show as touched.
 *
 * Asserted against the SOURCE, like globals-layering.test.ts, because these are
 * properties of this file rather than of a rendered page: jsdom resolves no
 * custom property it was not handed, so a DOM test would pass in both states.
 */

const GLOBALS = path.resolve(__dirname, "globals.css");

/**
 * The two font variables are declared by `next/font` on the <html> element in
 * `[locale]/layout.tsx`, not in this stylesheet. Every other `var()` in the file
 * must resolve within the file.
 */
const DECLARED_BY_NEXT_FONT: readonly string[] = ["--font-schibsted", "--font-jetbrains"];

/** Frozen. A name leaves this list only in a commit that rewrites every reader. */
const LEGACY_ROOT_PROPERTIES: readonly string[] = [
  "--paper",
  "--paper-2",
  "--card",
  "--ink",
  "--ink-2",
  "--muted",
  "--muted-2",
  "--line",
  "--line-soft",
  "--dark",
  "--dark-line",
  "--on-dark",
  "--on-dark-muted",
  "--accent",
  "--accent-bright",
  "--accent-soft",
  "--accent-ink",
  "--warn",
  "--ok",
  "--radius",
  "--radius-lg",
  "--radius-sm",
  "--maxw",
  "--pad",
];

/** Frozen. Every selector the out-of-scope auth screens and the shell depend on. */
const LEGACY_SELECTORS: readonly string[] = [
  ".eyebrow",
  ".lede",
  ".btn",
  ".btn--primary",
  ".btn--ghost",
  ".btn--sm",
  ".btn--block",
  ".link-accent",
  ".auth",
  ".auth__brand",
  ".auth__brand-inner",
  ".auth__brand-mark",
  ".auth__brand-line",
  ".auth__brand-foot",
  ".auth__panel",
  ".auth__card",
  ".auth__head",
  ".auth__foot",
  ".field",
  ".field__label",
  ".field__hint",
  ".field__error",
  ".input",
  ".input--code",
  ".check",
  ".grid-2",
  ".alert",
  ".alert--error",
  ".alert--ok",
  ".alert--info",
  ".alert__ref",
];

/**
 * Every density variable, which must exist on bare `:root` as well as in both
 * density blocks. The bare declaration is what keeps auth — which never receives
 * `data-density` — from silently losing its control heights and padding.
 */
const DENSITY_VARIABLES: readonly string[] = [
  "--font-body",
  "--control-h",
  "--control-px",
  "--row-h",
  "--cell-py",
  "--cell-px",
  "--card-p",
  "--badge-h",
];

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length));
}

/** The body of the first block matching `selector {` at the start of a line. */
function blockBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opener = new RegExp(`(?:^|\\n)${escaped}\\s*\\{`);
  const match = opener.exec(css);
  if (match === null) {
    return null;
  }

  let depth = 1;
  let index = match.index + match[0].length;
  const start = index;
  while (index < css.length && depth > 0) {
    const char = css[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    index += 1;
  }
  return css.slice(start, index - 1);
}

describe("dashboard globals.css tokens", () => {
  const css = withoutComments(readFileSync(GLOBALS, "utf8"));

  it("still declares every legacy :root property", () => {
    for (const property of LEGACY_ROOT_PROPERTIES) {
      expect(
        new RegExp(`^\\s*${property}\\s*:`, "m").test(css),
        `${property} is read by the legacy semantic classes that style the five ` +
          "auth screens, which render outside DashboardShell. Retiring it changes " +
          "screens no diff would show as touched.",
      ).toBe(true);
    }
  });

  it("still declares every legacy auth-facing selector", () => {
    for (const selector of LEGACY_SELECTORS) {
      expect(css.includes(selector), `${selector} is still applied by auth or the shell`).toBe(
        true,
      );
    }
  });

  it("declares every custom property it references", () => {
    const used = new Set(Array.from(css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g), (m) => m[1] ?? ""));
    const declared = new Set(
      Array.from(css.matchAll(/(?:^|\n)\s*(--[A-Za-z0-9-]+)\s*:/g), (m) => m[1] ?? ""),
    );

    const missing = [...used].filter(
      (name) => !declared.has(name) && !DECLARED_BY_NEXT_FONT.includes(name),
    );

    // An undefined var() with no fallback is invalid-at-computed-value-time: the
    // whole declaration is dropped. No error, no warning, no failing render —
    // just a control with no height. This is the guard for that.
    expect(missing, "undeclared custom properties silently drop their declaration").toEqual([]);
  });

  it("declares every density variable on bare :root and in both density blocks", () => {
    const compact = blockBody(css, '[data-density="compact"]');
    const comfortable = blockBody(css, '[data-density="comfortable"]');
    expect(compact, "the compact density block should exist").not.toBeNull();
    expect(comfortable, "the comfortable density block should exist").not.toBeNull();

    // The bare-root default must appear OUTSIDE any [data-density] block, so
    // check the file with both blocks removed.
    const outsideDensity = css.replace(/\[data-density="[a-z]+"\]\s*\{[^}]*\}/g, "");

    for (const variable of DENSITY_VARIABLES) {
      const pattern = new RegExp(`^\\s*${variable}\\s*:`, "m");
      expect(
        pattern.test(outsideDensity),
        `${variable} needs a bare :root default — auth renders outside DashboardShell ` +
          "and never receives data-density, so without one the declaration reading it " +
          "is dropped entirely.",
      ).toBe(true);
      expect(pattern.test(compact ?? ""), `${variable} missing from the compact block`).toBe(true);
      expect(
        pattern.test(comfortable ?? ""),
        `${variable} missing from the comfortable block`,
      ).toBe(true);
    }
  });

  it("carries the role block, the gutter queries and the transparency override", () => {
    expect(css).toContain("--bg-grouped:");
    expect(css).toContain("--label:");
    expect(css).toContain("--attention-fill:");
    expect(css).toContain("--r-control:");
    expect(css).toContain("--glass-fill:");
    expect(css).toMatch(/@media \(min-width: 640px\)[\s\S]*?--gutter: 20px/);
    expect(css).toMatch(/@media \(min-width: 1024px\)[\s\S]*?--gutter: 24px/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*?--glass-blur: none/);
    expect(css).toContain(".nx-glass");
  });

  it("keeps --accent declared exactly once", () => {
    // It is shared with the storefront under a comment demanding a mirrored
    // commit. Two declaration sites means two places to forget.
    const declarations = css.match(/^\s*--accent\s*:/gm) ?? [];
    expect(declarations).toHaveLength(1);
  });
});
