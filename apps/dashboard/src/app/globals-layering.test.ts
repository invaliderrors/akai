import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * REGRESSION: the element reset must stay inside `@layer base`.
 *
 * Tailwind v4 emits utilities into `@layer utilities`, and UNLAYERED css beats
 * any layered rule regardless of specificity. So an unlayered
 * `a { color: inherit }` silently overrode `text-white` on every anchor in the
 * app: `bg-zinc-900` applied and `text-white` did not, and the "New product"
 * button rendered black text on a black fill. Nothing errors — the class is in
 * the markup, the utility is in the stylesheet, and the colour is simply lost.
 *
 * Asserted against the SOURCE rather than a rendered page because the failure is
 * a cascade-order property of this file, and jsdom does not implement `@layer`
 * precedence — a DOM test here would pass in both the broken and fixed states.
 */

const GLOBALS = path.resolve(__dirname, "globals.css");

/** The character offsets of every top-level `@layer <name> { … }` block. */
function layerRanges(css: string): { name: string; start: number; end: number }[] {
  const ranges: { name: string; start: number; end: number }[] = [];
  const opener = /@layer\s+([a-zA-Z-]+)\s*\{/g;

  let match = opener.exec(css);
  while (match !== null) {
    const name = match[1] ?? "";
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < css.length && depth > 0) {
      const char = css[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      index += 1;
    }
    ranges.push({ name, start: match.index, end: index });
    match = opener.exec(css);
  }
  return ranges;
}

function isInsideLayer(css: string, offset: number, layer: string): boolean {
  return layerRanges(css).some(
    (range) => range.name === layer && offset > range.start && offset < range.end,
  );
}

/**
 * Comments are stripped first. The explanatory comment above the reset quotes
 * the very rule under test, and an `indexOf` would find the PROSE before the
 * declaration — a test that fails against correct source.
 */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length));
}

describe("dashboard globals.css layering", () => {
  const css = withoutComments(readFileSync(GLOBALS, "utf8"));

  it("keeps the anchor reset inside @layer base", () => {
    const offset = css.indexOf("a { color: inherit; text-decoration: none; }");
    expect(offset, "the anchor reset should still exist").toBeGreaterThan(-1);
    expect(
      isInsideLayer(css, offset, "base"),
      "an UNLAYERED `a { color: inherit }` overrides text-white on every anchor — " +
        "the black-on-black button bug. Keep it in @layer base.",
    ).toBe(true);
  });

  it("keeps the button reset inside @layer base", () => {
    // `button { font: inherit }` beats `text-sm` the same way.
    const offset = css.indexOf("button { font: inherit; cursor: pointer; }");
    expect(offset).toBeGreaterThan(-1);
    expect(isInsideLayer(css, offset, "base")).toBe(true);
  });

  it("keeps the focus ring inside @layer base", () => {
    /**
     * The same trap one layer up, and the reason a component kit needs this.
     * An unlayered `:focus-visible { outline: … }` beats
     * `focus-visible:outline-none` emitted into `@layer utilities`, so a
     * primitive that paints its own ring renders two — the browser outline and
     * the ring — with nothing to see in a jsdom test.
     */
    const offset = css.indexOf(":focus-visible { outline: 2px solid var(--accent)");
    expect(offset, "the focus ring should still exist").toBeGreaterThan(-1);
    expect(
      isInsideLayer(css, offset, "base"),
      "an UNLAYERED :focus-visible outline overrides focus-visible:outline-none, " +
        "so every primitive with its own ring paints a doubled one. Keep it in @layer base.",
    ).toBe(true);
  });

  it("still imports tailwind, so the layers exist at all", () => {
    expect(css).toContain('@import "tailwindcss"');
  });
});
