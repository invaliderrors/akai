import { describe, expect, it } from "vitest";

import { clipAbove, clipPolygon, panelShape, svgPoints } from "./panel-shapes";

describe("panelShape", () => {
  it("insets each corner from the box", () => {
    expect(panelShape("t", false)).toEqual([
      [0, 0],
      [100, 1.5],
      [96.5, 100],
      [1.5, 97],
    ]);
  });

  it("halves the skew on mobile", () => {
    expect(panelShape("t", true)).toEqual([
      [0, 0],
      [100, 0.75],
      [98.25, 100],
      [0.75, 98.5],
    ]);
  });
});

describe("formatting", () => {
  const shape = panelShape("f", false);

  it("renders a CSS clip polygon and SVG points", () => {
    expect(clipPolygon(shape)).toBe("polygon(2% 0.5%,100% 0%,100% 100%,0% 98.5%)");
    expect(svgPoints(shape)).toBe("2,0.5 100,0 100,100 0,98.5");
  });

  it("extends the side edges above the box along their slope", () => {
    // Left edge runs from (2, 0.5) to (0, 98.5): 40% higher sits a little further right.
    expect(clipAbove(shape, 40)).toBe("polygon(2.83% -40%,100.00% -40%,100% 100%,0% 98.5%)");
  });
});
