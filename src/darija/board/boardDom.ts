"use client";

/**
 * Shared DOM measuring helpers for hand-drawn chalk marks (per-block annotations
 * and cross-block connector arrows). Kept isolated so both layers measure targets
 * and draw smooth chalk strokes the exact same way.
 */
import { mapMatchChar, normalizeMatchText } from "./annotate";

export type Box = { x: number; y: number; w: number; h: number };
export type Point = [number, number];

/** Text that is not really on the page: measuring twins, MathML copies, overlays. */
export const SKIP_SELECTOR = ".chalk-measure, .katex-mathml, .board-annotations, .board-connectors, .chalk-frame";

/**
 * Finds the on-screen box of the `occurrence`-th visible match of `target` inside
 * `root`, in coordinates relative to `root`. Works across mixed handwritten text
 * and typeset KaTeX because it walks the real rendered text nodes.
 */
/** Elements whose text is rendered as mathematics (typeset formulas). */
const MATH_SELECTOR = ".board-latex, .board-latex-inline, .katex";

type CharEntry = { node: Text; offset: number; ch: string; math: Element | null };

/** Every visible character under `root`, in reading order, tagged with its math scope. */
function collectChars(root: HTMLElement): CharEntry[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement && node.parentElement.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const chars: CharEntry[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const math = text.parentElement ? text.parentElement.closest(MATH_SELECTOR) : null;
    for (let i = 0; i < text.data.length; i += 1) {
      if (/\s/.test(text.data[i])) continue;
      chars.push({ node: text, offset: i, ch: mapMatchChar(text.data[i]), math });
    }
  }
  return chars;
}

/** Screen box of chars[start .. start+len-1], relative to `root`. */
function boxOfRange(root: HTMLElement, chars: CharEntry[], start: number, len: number): Box | null {
  const first = chars[start];
  const last = chars[start + len - 1];
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);

  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0.5 && rect.height > 0.5);
  if (!rects.length) return null;

  // A target wrapped over several lines is marked on its first line only; rects of
  // the same line (a superscript sits higher) are merged into one box.
  const lead = rects[0];
  const bandTop = lead.top - lead.height * 0.6;
  const bandBottom = lead.bottom + lead.height * 0.6;
  const line = rects.filter((rect) => {
    const centre = rect.top + rect.height / 2;
    return centre >= bandTop && centre <= bandBottom;
  });

  const left = Math.min(...line.map((rect) => rect.left));
  const right = Math.max(...line.map((rect) => rect.right));
  const top = Math.min(...line.map((rect) => rect.top));
  const bottom = Math.max(...line.map((rect) => rect.bottom));
  const rootRect = root.getBoundingClientRect();
  return { x: left - rootRect.left, y: top - rootRect.top, w: right - left, h: bottom - top };
}

export type FindTargetOptions = {
  /** Only match inside this surrounding expression (e.g. "z = a + ib"). */
  within?: string;
  /**
   * Search rendered formulas BEFORE prose (default true). Without it, marking the
   * "a" of z = a + ib inside a sentence lands on the first "a" of the French text.
   */
  preferMath?: boolean;
};

/**
 * Finds the on-screen box of the `occurrence`-th visible match of `target` inside
 * `root`, in coordinates relative to `root`. Works across mixed handwritten text
 * and typeset KaTeX because it walks the real rendered text nodes.
 *
 * Resolution order: an explicit `within` expression, then each rendered formula,
 * then the block as a whole — so a single letter always lands on the equation
 * rather than on the same letter inside the surrounding sentence.
 */
export function findTargetBox(
  root: HTMLElement,
  target: string,
  occurrence: number,
  options: FindTargetOptions = {},
): Box | null {
  const chars = collectChars(root);
  if (!chars.length) return null;
  const haystack = chars.map((item) => item.ch).join("");
  const needle = normalizeMatchText(target);
  if (!needle) return null;

  const windows: Array<[number, number]> = [];

  const withinNeedle = options.within ? normalizeMatchText(options.within) : "";
  if (withinNeedle) {
    const at = haystack.indexOf(withinNeedle);
    if (at >= 0) windows.push([at, at + withinNeedle.length]);
  }

  if (options.preferMath !== false) {
    // Each contiguous run of characters belonging to one formula is its own window.
    let start = -1;
    for (let i = 0; i <= chars.length; i += 1) {
      const math = i < chars.length ? chars[i].math : null;
      const open = start >= 0;
      if (math && !open) start = i;
      else if (open && (!math || math !== chars[start].math)) {
        windows.push([start, i]);
        start = math ? i : -1;
      }
    }
  }

  windows.push([0, chars.length]);

  for (const [lo, hi] of windows) {
    const slice = haystack.slice(lo, hi);
    let from = 0;
    let found = -1;
    for (let n = 0; n < Math.max(1, occurrence); n += 1) {
      const at = slice.indexOf(needle, from);
      if (at < 0) {
        found = -1;
        break;
      }
      found = at;
      from = at + needle.length;
    }
    if (found >= 0) return boxOfRange(root, chars, lo + found, needle.length);
  }
  return null;
}

/**
 * The box of `target` inside `el` (or the whole element's box when no target is
 * given), expressed relative to `container` — used to place cross-block arrows.
 */
export function findBoxRelativeTo(
  el: HTMLElement,
  container: HTMLElement,
  target: string | undefined,
  occurrence: number,
): Box | null {
  // Overlay SVGs live inside the scrolling zone and scroll WITH its content, so
  // coordinates must be content-relative: viewport offset + current scroll position.
  const containerRect = container.getBoundingClientRect();
  const originX = containerRect.left + container.clientLeft - container.scrollLeft;
  const originY = containerRect.top + container.clientTop - container.scrollTop;
  if (target) {
    const local = findTargetBox(el, target, occurrence);
    if (!local) return null;
    const elRect = el.getBoundingClientRect();
    return {
      x: local.x + elRect.left - originX,
      y: local.y + elRect.top - originY,
      w: local.w,
      h: local.h,
    };
  }
  const elRect = el.getBoundingClientRect();
  return {
    x: elRect.left - originX,
    y: elRect.top - originY,
    w: elRect.width,
    h: elRect.height,
  };
}

/** Catmull-Rom spline through the points, as a cubic-Bézier SVG path. */
export function smoothPath(points: Point[]): string {
  if (points.length < 2) return "";
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))];
  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Deterministic hash so a mark keeps the same wobble/seed on every re-render. */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Small deterministic RNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
