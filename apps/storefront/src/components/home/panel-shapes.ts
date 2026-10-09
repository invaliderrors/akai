/**
 * The skewed manga-panel outlines of the home page's category grid, in percent
 * of each panel's box. The category markup clips and strokes them; the thread
 * script reads the same points to run the red thread between the panels.
 */

export type PanelKey = "f" | "t" | "o" | "s";
export type Point = readonly [number, number];
export type Quad = readonly [Point, Point, Point, Point];

/** Inset of each corner from the box corner (tl, tr, br, bl), at full scale. */
const INSETS: Readonly<Record<PanelKey, Quad>> = {
  t: [[0, 0], [0, 1.5], [3.5, 0], [1.5, 3]],
  o: [[3.5, 1], [0, 0], [2, 4], [0, 0]],
  s: [[0, 3], [1, 0], [0, 0], [0.5, 2]],
  f: [[2, 0.5], [0, 0], [0, 0], [0, 1.5]],
};

const round = (value: number) => Number(value.toFixed(2));

/** Corners tl, tr, br, bl. Mobile halves the skew. */
export function panelShape(key: PanelKey, mobile: boolean): Quad {
  const m = mobile ? 0.5 : 1;
  const [tl, tr, br, bl] = INSETS[key];
  const r = (value: number) => round(value * m);
  return [
    [r(tl[0]), r(tl[1])],
    [round(100 - r(tr[0])), r(tr[1])],
    [round(100 - r(br[0])), round(100 - r(br[1]))],
    [r(bl[0]), round(100 - r(bl[1]))],
  ];
}

export function clipPolygon(shape: Quad): string {
  return `polygon(${shape.map(([x, y]) => `${String(x)}% ${String(y)}%`).join(",")})`;
}

export function svgPoints(shape: Quad): string {
  return shape.map(([x, y]) => `${String(x)},${String(y)}`).join(" ");
}

/**
 * The same panel with its top edge pushed `up` percent above the box, the
 * side edges extended along their slope — so art can rise out of the panel
 * while staying inside its sides.
 */
export function clipAbove(shape: Quad, up: number): string {
  const [tl, tr, br, bl] = shape;
  const extend = (a: Point, b: Point) => (a[0] + (a[0] - b[0]) * ((a[1] + up) / (b[1] - a[1] || 1))).toFixed(2);
  return `polygon(${extend(tl, bl)}% -${String(up)}%,${extend(tr, br)}% -${String(up)}%,${String(br[0])}% ${String(br[1])}%,${String(bl[0])}% ${String(bl[1])}%)`;
}
