import { panelShape, type PanelKey, type Quad } from "@/components/home/panel-shapes";

/**
 * The red thread (赤い糸) of the home page: one stroke from the top-left
 * edge, through the hero card, around the category panels, past the knight's
 * halo, pin to pin across the reviews wall and into the knot on the footer
 * seal. It draws itself as the page scrolls.
 *
 * The page marks waypoints with `data-thread` ("L"/"R" = left/right gutter,
 * a number = that fraction of the width, "Ro" = right gutter on the offer,
 * "halo" = loop the knight's halo). Everything is re-measured whenever the
 * layout moves.
 */

interface Pt {
  x: number;
  y: number;
}
interface Mark extends Pt {
  brk?: boolean;
}
type Layer = "f" | "b";
interface LayerPt extends Pt {
  L?: Layer;
}
interface Group {
  layer: Layer;
  d: string;
  len: number;
  delay: number;
  dur: number;
}
interface Piece {
  d: string;
  len: number;
  delay: number;
  dur: number;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const q = (v: number) => v.toFixed(1);

const root = document.querySelector<HTMLElement>("[data-thread-root]");
const svg = root?.querySelector<SVGSVGElement>("[data-thread-svg]") ?? null;
const path = svg?.querySelector("path") ?? null;

if (root !== null && svg !== null && path !== null) {
  const mqMobile = matchMedia("(max-width: 760px)");
  const mqTablet = matchMedia("(max-width: 1100px)");
  const mqReduce = matchMedia("(prefers-reduced-motion: reduce)");
  const mode = (): "m" | "t" | "d" => (mqMobile.matches ? "m" : mqTablet.matches ? "t" : "d");

  let pageH = 1;
  let signature = "";
  let catDrawn = false;
  let wallDrawn = false;

  const visible = (el: Element) => el.getClientRects().length > 0;

  const updateDash = () => {
    if (mqReduce.matches) {
      path.style.strokeDashoffset = "0";
      return;
    }
    const progress = Math.min(1, ((window.scrollY + window.innerHeight) / Math.max(1, pageH)) * 1.03);
    path.style.strokeDashoffset = String(1 - progress);
  };

  /** Catmull-Rom through the points, as cubic Béziers, clamped to the page. */
  const curve = (pts: readonly Pt[], minX: number, maxX: number) => {
    const first = pts[0];
    if (first === undefined) return "";
    const cx = (v: number) => Math.max(minX, Math.min(maxX, v));
    let d = `M${q(first.x)} ${q(first.y)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      if (p1 === undefined || p2 === undefined) continue;
      const p0 = pts[i - 1] ?? p1;
      const p3 = pts[i + 2] ?? p2;
      d += ` C${q(cx(p1.x + (p2.x - p0.x) / 6))} ${q(p1.y + (p2.y - p0.y) / 6)} ${q(cx(p2.x - (p3.x - p1.x) / 6))} ${q(p2.y - (p3.y - p1.y) / 6)} ${q(p2.x)} ${q(p2.y)}`;
    }
    return d;
  };

  function catThread(rb: DOMRect) {
    const grid = root?.querySelector<HTMLElement>("[data-cat-grid]");
    if (grid === null || grid === undefined) return null;
    const gr = grid.getBoundingClientRect();
    const gx0 = gr.left - rb.left;
    const gy0 = gr.top - rb.top;
    const W = grid.clientWidth;
    const GH = grid.offsetHeight;
    const mt = parseFloat(getComputedStyle(grid).marginTop) || 80;
    const head = root?.querySelector("[data-cat-head] h2");
    const m = mode();
    const panel = (key: PanelKey) => {
      const el = grid.querySelector<HTMLElement>(`[data-panel="${key}"]`);
      return el === null
        ? null
        : { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, s: panelShape(key, m === "m") };
    };
    const f = panel("f");
    const t = panel("t");
    const o = panel("o");
    const s = panel("s");
    if (f === null || t === null || o === null || s === null || W === 0) return null;

    type P = Box & { s: Quad };
    const P = (b: P, i: 0 | 1 | 2 | 3): Pt => ({ x: b.x + (b.w * b.s[i][0]) / 100, y: b.y + (b.h * b.s[i][1]) / 100 });
    const ix = (a: Pt, c: Pt, y: number) => a.x + ((c.x - a.x) * (y - a.y)) / (c.y - a.y || 1);
    const iy = (a: Pt, c: Pt, x: number) => a.y + ((c.y - a.y) * (x - a.x)) / (c.x - a.x || 1);
    const lx = (b: P, y: number) => ix(P(b, 0), P(b, 3), y);
    const rx = (b: P, y: number) => ix(P(b, 1), P(b, 2), y);
    const ty = (b: P, x: number) => iy(P(b, 0), P(b, 1), x);
    const by = (b: P, x: number) => iy(P(b, 3), P(b, 2), x);

    const yb = f.y + f.h * 0.93;
    const K: LayerPt = { x: lx(f, yb), y: yb, L: "f" };
    const ent = -mt * 0.55;
    const LM = -8;
    const RM = W + 8;
    const Mb: LayerPt = { x: (lx(f, yb) + rx(f, yb)) / 2, y: yb + 9, L: "f" };
    let pts: LayerPt[];
    if (m === "d") {
      const g = (y: number) => (rx(t, y) + lx(o, y)) / 2;
      const h = (y: number) => (rx(s, y) + lx(f, y)) / 2;
      const ys = s.y + s.h * 0.45;
      pts = [
        { x: g(t.y), y: ent, L: "f" },
        { x: g(t.y + 14), y: t.y + 14, L: "f" },
        { x: g(t.y + t.h - 16), y: t.y + t.h - 16, L: "b" },
        { x: h(ys), y: ys, L: "f" },
        { x: h(yb - 40), y: yb - 40, L: "f" },
        K,
        Mb,
        { x: rx(f, yb + 4) + 5, y: yb + 4, L: "b" },
        { x: rx(f, yb + 12) - 12, y: yb + 16 },
      ];
    } else if (m === "t") {
      const g = (y: number) => (rx(t, y) + lx(o, y)) / 2;
      const x0 = g(t.y);
      const yg = (by(f, x0) + ty(t, x0)) / 2;
      pts = [
        { x: LM, y: ent, L: "f" },
        { x: LM, y: yb - 44, L: "f" },
        K,
        Mb,
        { x: rx(f, yb + 4) + 5, y: yb + 4, L: "b" },
        { x: x0, y: yg, L: "f" },
        { x: g(t.y + 14), y: t.y + 14, L: "f" },
        { x: g(t.y + t.h - 16), y: t.y + t.h - 16, L: "b" },
        { x: s.x + s.w * 0.8, y: s.y + s.h * 0.5, L: "b" },
        { x: s.x + s.w * 0.88, y: s.y + s.h + 30 },
      ];
    } else {
      const mid = (a: P, b: P) => (by(a, W / 2) + ty(b, W / 2)) / 2;
      pts = [
        { x: LM, y: ent, L: "f" },
        { x: LM, y: yb - 40, L: "f" },
        K,
        Mb,
        { x: rx(f, yb + 4) + 4, y: yb + 4, L: "f" },
        { x: RM, y: f.y + f.h - 6, L: "f" },
        { x: W / 2, y: mid(f, t), L: "b" },
        { x: LM, y: t.y + t.h * 0.45, L: "f" },
        { x: LM, y: t.y + t.h - 8, L: "f" },
        { x: W / 2, y: mid(t, o), L: "b" },
        { x: RM, y: o.y + o.h * 0.45, L: "f" },
        { x: RM, y: o.y + o.h - 8, L: "f" },
        { x: W / 2, y: mid(o, s), L: "b" },
        { x: LM, y: s.y + s.h * 0.5, L: "f" },
        { x: LM, y: s.y + s.h + 28 },
      ];
    }

    // Split the curve wherever it passes behind (b) or in front of (f) the panels.
    const cx = (v: number) => Math.max(-14, Math.min(W + 14, v));
    const groups: Group[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      if (p1 === undefined || p2 === undefined) continue;
      const p0 = pts[i - 1] ?? p1;
      const p3 = pts[i + 2] ?? p2;
      const layer = p1.L ?? "f";
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const c = ` C${q(cx(p1.x + (p2.x - p0.x) / 6))} ${q(p1.y + (p2.y - p0.y) / 6)} ${q(cx(p2.x - (p3.x - p1.x) / 6))} ${q(p2.y - (p3.y - p1.y) / 6)} ${q(p2.x)} ${q(p2.y)}`;
      const last = groups.at(-1);
      if (last !== undefined && last.layer === layer) {
        last.d += c;
        last.len += len;
      } else {
        groups.push({ layer, d: `M${q(p1.x)} ${q(p1.y)}${c}`, len, delay: 0, dur: 0 });
      }
    }
    const total = groups.reduce((sum, g) => sum + g.len, 0) || 1;
    const T = 1.8;
    let acc = 0;
    for (const g of groups) {
      g.delay = Number(((acc / total) * T).toFixed(3));
      g.dur = Number(((g.len / total) * T).toFixed(3));
      acc += g.len;
    }
    // The knot tied round the Weekly Exclusive's corner.
    const kp = (dx: number, dy: number) => `${q(K.x + dx)} ${q(K.y + dy)}`;
    groups.push({
      layer: "f",
      len: 0,
      delay: Number((T * 0.85).toFixed(2)),
      dur: 0.45,
      d: `M${kp(-9, -5)} C${kp(-3, -12)} ${kp(9, -9)} ${kp(6, 0)} C${kp(3, 8)} ${kp(-9, 6)} ${kp(-5, -1)} C${kp(-2, -6)} ${kp(6, -3)} ${kp(9, 3)} M${kp(1, 2)} C${kp(4, 10)} ${kp(2, 18)} ${kp(-3, 26)} M${kp(3, 2)} C${kp(9, 9)} ${kp(13, 16)} ${kp(12, 25)}`,
    });
    const first = pts[0] ?? K;
    const last = m === "d" ? { x: K.x - 3, y: K.y + 26 } : (pts.at(-1) ?? K);
    return {
      groups,
      sig: groups.map((g) => g.d).join("|"),
      entry: { x: gx0 + first.x, y: gy0 + first.y },
      exit: { x: gx0 + last.x, y: gy0 + last.y },
      top: gy0,
      bottom: gy0 + GH,
      headRight: head === null || head === undefined ? 0 : head.getBoundingClientRect().right - rb.left,
    };
  }

  function wallThread(rb: DOMRect) {
    const track = root?.querySelector<HTMLElement>("[data-wall-track]");
    if (track === null || track === undefined) return null;
    const cards = [...track.querySelectorAll<HTMLElement>("[data-wall-card]")];
    if (cards.length < 2) return null;
    const tr = track.getBoundingClientRect();
    const tx = tr.left - rb.left;
    const ty = tr.top - rb.top;
    const TW = track.offsetWidth;
    const TH = track.offsetHeight;
    const m = mode();
    const pins = cards.map((c) => ({ x: c.offsetLeft + c.offsetWidth / 2, y: c.offsetTop + 16, w: c.offsetWidth }));
    const dist = (p: Pt, r: Pt) => Math.hypot(r.x - p.x, r.y - p.y);
    const sag = (p: Pt, r: Pt) => {
      const dx = r.x - p.x;
      const sg = 14 + Math.abs(dx) * 0.09;
      return {
        d: `M${q(p.x)} ${q(p.y)} C${q(p.x + dx / 3)} ${q(p.y + sg)} ${q(r.x - dx / 3)} ${q(r.y + sg)} ${q(r.x)} ${q(r.y)}`,
        len: dist(p, r) * 1.08,
      };
    };
    const via = (pts: Pt[]) => {
      let len = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (a !== undefined && b !== undefined) len += dist(a, b);
      }
      return { d: curve(pts, -Infinity, Infinity), len };
    };
    const pieces: Piece[] = [];
    const push = (piece: { d: string; len: number }) => pieces.push({ ...piece, delay: 0, dur: 0 });
    let order: number[];
    if (m === "d") {
      order = pins.map((_, i) => i).sort((a, b) => (pins[b]?.x ?? 0) - (pins[a]?.x ?? 0));
      for (let i = 0; i < order.length - 1; i++) {
        const a = pins[order[i] ?? 0];
        const b = pins[order[i + 1] ?? 0];
        if (a !== undefined && b !== undefined) push(sag(a, b));
      }
    } else if (m === "t") {
      order = [];
      for (let r = 0; r * 2 < pins.length; r++) {
        const a = 2 * r;
        const b = Math.min(2 * r + 1, pins.length - 1);
        for (const k of r % 2 === 0 ? [b, a] : [a, b]) if (!order.includes(k)) order.push(k);
      }
      for (let i = 0; i < order.length - 1; i++) {
        const p = pins[order[i] ?? 0];
        const r = pins[order[i + 1] ?? 0];
        if (p === undefined || r === undefined) continue;
        if (Math.abs(r.y - p.y) < 120) push(sag(p, r));
        else {
          const mx = p.x < TW / 2 ? 12 : TW - 12;
          push(via([p, { x: mx, y: p.y + 40 }, { x: mx, y: r.y - 40 }, r]));
        }
      }
    } else {
      order = pins.map((_, i) => i);
      const first = pins[0];
      const last = pins.at(-1);
      if (first !== undefined && last !== undefined) {
        push(via([{ x: -22, y: first.y + 20 }, first]));
        for (let i = 0; i < pins.length - 1; i++) {
          const a = pins[i];
          const b = pins[i + 1];
          if (a !== undefined && b !== undefined) push(sag(a, b));
        }
        push(via([last, { x: last.x + last.w / 2 + 40, y: last.y + 22 }]));
      }
    }
    const total = pieces.reduce((sum, p) => sum + p.len, 0) || 1;
    const T = 2.4;
    let acc = 0;
    for (const p of pieces) {
      p.delay = Number(((acc / total) * T).toFixed(3));
      p.dur = Number(((p.len / total) * T).toFixed(3));
      acc += p.len;
    }
    const e = pins[order[0] ?? 0];
    const x = pins[order.at(-1) ?? 0];
    return {
      pieces,
      pins: pins.map((p) => ({ x: Number(q(p.x)), y: Number(q(p.y)) })),
      sig: pieces.map((p) => p.d).join("|"),
      top: ty,
      bottom: ty + TH,
      entry: m === "m" || e === undefined ? null : { x: tx + e.x, y: ty + e.y },
      exit: m === "m" || x === undefined ? null : { x: tx + x.x, y: ty + x.y },
    };
  }

  const strokePath = (d: string, width: number, drawn: boolean, dur: number, delay: number) => {
    const el = document.createElementNS(SVG_NS, "path");
    el.setAttribute("d", d);
    el.setAttribute("pathLength", "1");
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "var(--color-akai)");
    el.setAttribute("stroke-width", String(width));
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    el.style.strokeDasharray = "1";
    el.style.strokeDashoffset = drawn ? "0" : "1";
    el.style.transition = mqReduce.matches ? "none" : `stroke-dashoffset ${String(dur)}s linear ${String(delay)}s`;
    return el;
  };

  function renderCat(groups: readonly Group[]) {
    const drawn = mqReduce.matches || catDrawn;
    for (const layer of ["b", "f"] as const) {
      const host = root?.querySelector<SVGSVGElement>(`[data-cat-layer="${layer}"]`);
      host?.replaceChildren(
        ...groups.filter((g) => g.layer === layer).map((g) => strokePath(g.d, 2.5, drawn, g.dur, g.delay)),
      );
    }
  }

  function renderWall(pieces: readonly Piece[], pins: readonly Pt[]) {
    const host = root?.querySelector<SVGSVGElement>("[data-wall-layer]");
    if (host === null || host === undefined) return;
    const drawn = mqReduce.matches || wallDrawn;
    const pinEls = pins.map((p) => {
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("transform", `translate(${String(p.x)} ${String(p.y)})`);
      const shadow = document.createElementNS(SVG_NS, "ellipse");
      Object.entries({ cx: "2.5", cy: "3.5", rx: "6.5", ry: "5.5", fill: "color-mix(in srgb, var(--color-ink) 28%, transparent)" }).forEach(
        ([k, v]) => shadow.setAttribute(k, v),
      );
      const head = document.createElementNS(SVG_NS, "circle");
      Object.entries({ r: "6.5", fill: "var(--color-akai)", stroke: "var(--color-akai-deep)", "stroke-width": "1" }).forEach(([k, v]) =>
        head.setAttribute(k, v),
      );
      const shine = document.createElementNS(SVG_NS, "circle");
      Object.entries({ cx: "-2.2", cy: "-2.4", r: "2", fill: "color-mix(in srgb, var(--color-white) 75%, transparent)" }).forEach(
        ([k, v]) => shine.setAttribute(k, v),
      );
      g.append(shadow, head, shine);
      return g;
    });
    host.replaceChildren(...pieces.map((p) => strokePath(p.d, 2, drawn, p.dur, p.delay)), ...pinEls);
  }

  function measure() {
    if (root === null || svg === null || path === null) return;
    const rb = root.getBoundingClientRect();
    const W = root.clientWidth;
    const H = root.scrollHeight;
    const margin = Math.max(0, (W - 1280) / 2) + 16;
    const edge = Math.max(5, margin - 22);
    const wob = Math.max(2, Math.min(26, margin - edge - 6));
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { x: r.left - rb.left, y: r.top - rb.top, w: r.width, h: r.height };
    };
    const mob = mode() === "m";
    const knight = root.querySelector("[data-knight]");
    const halo = (k: string): Pt | null => {
      const el = knight?.querySelector(`[data-halo="${k}"]`);
      if (el === null || el === undefined) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - rb.left, y: r.top - rb.top };
    };

    let seenRo = false;
    const marks: Mark[] = [...root.querySelectorAll<HTMLElement>("[data-thread]")].flatMap((el): Mark[] => {
      const b = box(el);
      const v = el.dataset.thread ?? "";
      const y = b.y + b.h / 2;
      if (v === "halo") {
        const hc = halo("c");
        const hr = halo("r");
        const ht = halo("t");
        if (hc === null || hr === null || ht === null) return [];
        let u = { x: hr.x - hc.x, y: hr.y - hc.y };
        if (u.x < 0) u = { x: -u.x, y: -u.y };
        const vv = { x: ht.x - hc.x, y: ht.y - hc.y };
        const P = (a: number, c: number) => ({ x: hc.x + a * u.x + c * vv.x, y: hc.y + a * u.y + c * vv.y });
        if (mob) return [{ brk: true, x: 0, y }, P(-0.4, -1.0), P(-1.3, -0.1), P(-0.2, 1.45), P(1.3, 0.3), P(0.6, -1.1), { brk: true, x: 0, y }];
        return [P(1.35, -0.15), P(0, -1.05), P(-1.35, -0.1), P(-0.2, 1.45), P(1.3, 0.35)];
      }
      if (v === "Ro") {
        const first = !seenRo;
        seenRo = true;
        if (mob && !first) return [];
        return [{ x: W - edge, y }];
      }
      return [{ x: v === "L" ? edge : v === "R" ? W - edge : parseFloat(v) * W, y }];
    });

    const build = (pts: readonly Pt[]) => {
      const P: Pt[] = [];
      pts.forEach((p, i) => {
        P.push({ x: p.x, y: p.y });
        const n = pts[i + 1];
        if (n !== undefined && n.y - p.y > 320) P.push({ x: (p.x + n.x) / 2 + (i % 2 ? wob : -wob), y: (p.y + n.y) / 2 });
      });
      for (const p of P) p.x = Math.max(4, Math.min(W - 4, p.x));
      return curve(P, 4, W - 4);
    };
    const buildS = (list: readonly Mark[]) => {
      const out: string[] = [];
      let chunk: Pt[] = [];
      for (const p of list) {
        if (p.brk === true) {
          if (chunk.length > 1) out.push(build(chunk));
          chunk = [];
        } else chunk.push(p);
      }
      if (chunk.length > 1) out.push(build(chunk));
      return out.join(" ");
    };

    const img = root.querySelector("[data-thread-img]");
    const card = root.querySelector("[data-thread-card]");
    const seal = root.querySelector("[data-foot-seal]");
    const sealBox = seal === null ? null : box(seal);
    const end = sealBox === null ? { x: edge, y: H - 4 } : { x: sealBox.x + 14, y: sealBox.y };
    const cat = catThread(rb);
    const wall = wallThread(rb);
    const tail = (start: Pt, list: readonly Mark[]) => {
      if (wall === null) return buildS([start, ...list, end]);
      const pre = list.filter((mk) => mk.y < wall.top);
      const post = list.filter((mk) => mk.y > wall.bottom);
      return wall.entry !== null && wall.exit !== null
        ? `${buildS([start, ...pre, { x: W - edge, y: wall.top + 8 }, wall.entry])} ${buildS([wall.exit, ...post, end])}`
        : `${buildS([start, ...pre])} ${buildS([...post, end])}`;
    };

    let d: string;
    const firstMark = marks[0];
    if (img !== null && firstMark !== undefined) {
      const g = box(img);
      const c = card === null ? g : box(card);
      const avoid = root.querySelector("[data-thread-avoid]");
      const avB = avoid !== null && visible(avoid) ? box(avoid).y + box(avoid).h : 0;
      const conn = { x: g.x + g.w * 0.1, y: Math.min(g.y + g.h * 0.85, Math.max(g.y + g.h * 0.5, avB + 70)) };
      const cardMid = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
      const head = build([{ x: edge, y: 0 }, firstMark, { x: edge, y: Math.max(firstMark.y + 40, avB + 20, conn.y - 110) }, conn]);
      const rest =
        cat === null
          ? buildS([cardMid, ...marks.slice(1), end])
          : `${build([
              cardMid,
              ...marks.slice(1).filter((mk) => mk.y < cat.top),
              { x: Math.min(W - edge, Math.max(cat.headRight + 60, cat.entry.x + 90)), y: cat.entry.y },
              cat.entry,
            ])} ${tail(
              cat.exit,
              marks.filter((mk) => mk.y > cat.bottom),
            )}`;
      d = `${head} ${rest}`;
    } else {
      d = buildS([{ x: edge, y: 0 }, ...marks, end]);
    }

    const sig = `${d}#${cat?.sig ?? ""}#${wall?.sig ?? ""}#${String(W)}x${String(H)}`;
    if (sig !== signature) {
      signature = sig;
      pageH = H;
      svg.setAttribute("height", String(H));
      svg.setAttribute("viewBox", `0 0 ${String(W)} ${String(H)}`);
      path.setAttribute("d", d);
      renderCat(cat?.groups ?? []);
      renderWall(wall?.pieces ?? [], wall?.pins ?? []);
    }
    updateDash();
  }

  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  };

  /** Draw a section's own thread once a good part of it is on screen. */
  const drawWhenSeen = (selector: string, delay: number, onDraw: () => void) => {
    const target = root.querySelector(selector);
    if (target === null || !("IntersectionObserver" in window)) {
      onDraw();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting && e.intersectionRect.height > Math.min(180, window.innerHeight * 0.3))) {
          setTimeout(onDraw, delay);
          io.disconnect();
        }
      },
      { threshold: [0, 0.05, 0.1, 0.2, 0.3] },
    );
    io.observe(target);
  };
  const reveal = (selector: string) =>
    root.querySelectorAll<SVGPathElement>(`${selector} path`).forEach((el) => (el.style.strokeDashoffset = "0"));

  drawWhenSeen("[data-cat-grid]", 60, () => {
    catDrawn = true;
    reveal("[data-cat-layer]");
  });
  drawWhenSeen("[data-wall-track]", 80, () => {
    wallDrawn = true;
    reveal("[data-wall-layer]");
  });

  new ResizeObserver(schedule).observe(root);
  mqMobile.addEventListener("change", schedule);
  mqTablet.addEventListener("change", schedule);
  window.addEventListener("akai:layout-changed", schedule);
  window.addEventListener("scroll", updateDash, { passive: true });
  void document.fonts.ready.then(schedule);
  setTimeout(measure, 300);
}
