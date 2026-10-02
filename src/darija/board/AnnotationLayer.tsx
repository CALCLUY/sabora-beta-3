"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { findTargetBox, hashString, seededRandom, smoothPath, type Box, type Point } from "./boardDom";
import type { BoardAnnotation, ChalkColor } from "./types";

/**
 * Hand-drawn chalk annotations (circle / labelled arrow / underline) laid over a block.
 *
 * The target's real on-screen position is measured from the rendered DOM (a Range
 * over the matching characters), so it works for typeset KaTeX and for handwritten
 * text alike, and follows the block when the board is resized.
 */

type Geometry = {
  w: number;
  h: number;
  fs: number;
  /** Horizontal limits (block coordinates) labels must stay inside: the zone's edges. */
  minX: number;
  maxX: number;
  boxes: Record<string, Box | null>;
};

const CHALK: Record<ChalkColor, string> = { white: "#fdf7e6", yellow: "#ffe066", red: "#ff5b61", blue: "#7ec8ff" };

function useAnnotationGeometry(rootRef: RefObject<HTMLDivElement | null>, annotations: BoardAnnotation[]) {
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;
      const rootRect = root.getBoundingClientRect();
      const zone = root.closest(".board-zone-body");
      const zoneRect = zone ? zone.getBoundingClientRect() : rootRect;
      const round = (value: number) => Math.round(value * 2) / 2;

      const boxes: Record<string, Box | null> = {};
      for (const annotation of annotations) {
        const box = findTargetBox(root, annotation.target, annotation.occurrence, {
          within: annotation.within,
          preferMath: true,
        });
        boxes[annotation.id] = box
          ? { x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) }
          : null;
      }

      const next: Geometry = {
        w: round(root.offsetWidth),
        h: round(root.offsetHeight),
        fs: parseFloat(getComputedStyle(root).fontSize) || 20,
        minX: round(zoneRect.left - rootRect.left + 6),
        maxX: round(zoneRect.right - rootRect.left - 6),
        boxes,
      };
      setGeometry((previous) => (previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    const zone = root.closest(".board-zone-body");
    if (zone) observer.observe(zone);
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(() => measure()).catch(() => {});
    }
    // Once more after the text has swapped from its writing state to its final layout.
    const timer = window.setTimeout(measure, 160);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [rootRef, annotations]);

  return geometry;
}

/* ------------------------------------------------------------------------ */
/* Hand-drawn shapes                                                          */
/* ------------------------------------------------------------------------ */

/** A loose chalk loop around the box that overshoots its own start, like a real hand. */
function handCircle(box: Box, pad: number, random: () => number) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const ry = box.h * 0.5 + pad * 0.35;
  const rx = Math.max(box.w / 2 + pad * 1.1, ry * 0.9);
  const start = -Math.PI * 0.62 + (random() - 0.5) * 0.5;
  const sweep = Math.PI * 2 * 1.07;
  const steps = 26;
  const points: Point[] = [];
  for (let k = 0; k <= steps; k += 1) {
    const t = k / steps;
    const angle = start + t * sweep;
    const wobble = 1 + 0.035 * Math.sin(k * 1.9 + random() * 2) + 0.05 * t;
    points.push([cx + Math.cos(angle) * rx * wobble, cy + Math.sin(angle) * ry * wobble]);
  }
  return { d: smoothPath(points), cx, cy, ry: ry * 1.06 };
}

type Mark = {
  paths: Array<{ d: string; delay: number; duration: number }>;
  label?: { text: string; x: number; y: number; above: boolean; delay: number };
};

const STEP = {
  circle: 0.75,
  shaft: 0.5,
  head: 0.2,
};

/**
 * Collision-free label layout. For each side (above / below) the arrows' labels are
 * spread left-to-right IN THE SAME ORDER as their targets, never closer than their
 * own widths plus a gap, and kept inside the zone. Because the order of tails matches
 * the order of targets, the straight-ish shafts between them can never cross — and
 * because every arm has the same length, no shaft can cut through another label.
 */
function labelWidth(annotation: BoardAnnotation, fs: number): number {
  return annotation.label ? annotation.label.length * fs * 0.5 + 10 : 0;
}

function layoutTails(
  items: Array<{ annotation: BoardAnnotation; box: Box }>,
  geometry: Geometry,
): Map<string, number> {
  const { fs, minX, maxX } = geometry;
  const result = new Map<string, number>();
  const gap = Math.max(8, fs * 0.6);

  for (const side of ["above", "below"] as const) {
    const group = items
      .filter((item) => item.annotation.side === side)
      .map((item) => ({
        id: item.annotation.id,
        centre: item.box.x + item.box.w / 2,
        width: labelWidth(item.annotation, fs),
      }))
      .sort((a, b) => a.centre - b.centre);
    if (!group.length) continue;

    const position = group.map((item) => item.centre);
    const need = (i: number) => (group[i - 1].width + group[i].width) / 2 + gap;

    // Left-to-right: push labels apart.
    for (let i = 1; i < group.length; i += 1) position[i] = Math.max(position[i], position[i - 1] + need(i));
    // Keep the last one inside the zone, then pull the others back from the right.
    const last = group.length - 1;
    position[last] = Math.min(position[last], maxX - group[last].width / 2);
    for (let i = last - 1; i >= 0; i -= 1) position[i] = Math.min(position[i], position[i + 1] - need(i + 1));
    // Keep the first one inside the zone, then re-spread to the right if needed.
    position[0] = Math.max(position[0], minX + group[0].width / 2);
    for (let i = 1; i < group.length; i += 1) position[i] = Math.max(position[i], position[i - 1] + need(i));

    group.forEach((item, i) => result.set(item.id, position[i]));
  }
  return result;
}

function buildMark(
  annotation: BoardAnnotation,
  box: Box,
  geometry: Geometry,
  tailPosition: number | undefined,
  delay: number,
): Mark {
  const random = seededRandom(hashString(annotation.id));
  const { fs } = geometry;
  const pad = Math.max(5, fs * 0.3);
  const direction = annotation.side === "below" ? 1 : -1;
  const centreX = box.x + box.w / 2;
  // The tail (and its label) sits where the layout pass put it, not just above the target.
  const tailFor = (fallback: number) => (tailPosition === undefined ? fallback : tailPosition);

  const paths: Mark["paths"] = [];
  let clock = delay;

  // 1) The shape around / under the target.
  let headY = direction > 0 ? box.y + box.h * 0.9 + 3 : box.y + box.h * 0.1 - 3;
  let labelOnly = false;

  if (annotation.kind === "circle") {
    // Two slightly offset loops read as a confident hand-drawn circle instead of a
    // thin ring; the second pass overlaps the first like a real chalk double-stroke.
    const primary = handCircle(box, pad, random);
    paths.push({ d: primary.d, delay: clock, duration: STEP.circle });
    clock += STEP.circle - 0.1;
    const secondary = handCircle(box, pad * 0.72, random);
    paths.push({ d: secondary.d, delay: clock, duration: STEP.circle * 0.72 });
    clock += STEP.circle * 0.55;
    headY = direction > 0 ? primary.cy + primary.ry + 3 : primary.cy - primary.ry - 3;
  } else if (annotation.kind === "underline") {
    const y = box.y + box.h * 0.94 + 2;
    const x0 = box.x - pad * 0.3;
    const x1 = box.x + box.w + pad * 0.3;
    const segments = 6;
    const points: Point[] = [];
    for (let k = 0; k <= segments; k += 1) {
      const t = k / segments;
      points.push([x0 + (x1 - x0) * t, y + (random() - 0.5) * 2.4 + t * (random() - 0.3) * 2]);
    }
    paths.push({ d: smoothPath(points), delay: clock, duration: 0.55 });
    clock += 0.5;
    headY = y + 1;
    labelOnly = true;
  }

  // 2) Arrow (for arrows, and for a circle that carries a label). Underlines only label.
  let labelX = tailFor(centreX);
  let labelY = headY + direction * (fs * 0.55);

  if (!labelOnly && (annotation.kind === "arrow" || annotation.label)) {
    // Same arm length for every arrow: labels share one row, so shafts never cross a label.
    const length = fs * 1.5;
    const tailY = headY + direction * length;
    const tailX = tailFor(centreX + (random() - 0.5) * fs * 0.6);
    // Bow the shaft slightly toward the side it is being pushed from, so it stays hand-drawn.
    const controlX = (tailX + centreX) / 2 + (random() - 0.5) * fs * 0.25;
    const controlY = (tailY + headY) / 2;

    paths.push({
      d: `M ${tailX.toFixed(1)} ${tailY.toFixed(1)} Q ${controlX.toFixed(1)} ${controlY.toFixed(1)} ${centreX.toFixed(1)} ${headY.toFixed(1)}`,
      delay: clock,
      duration: STEP.shaft,
    });

    const angle = Math.atan2(headY - controlY, centreX - controlX);
    const wing = Math.max(8, fs * 0.42);
    const wingA: Point = [centreX - wing * Math.cos(angle - 0.5), headY - wing * Math.sin(angle - 0.5)];
    const wingB: Point = [centreX - wing * Math.cos(angle + 0.5), headY - wing * Math.sin(angle + 0.5)];
    paths.push({
      d: `M ${wingA[0].toFixed(1)} ${wingA[1].toFixed(1)} L ${centreX.toFixed(1)} ${headY.toFixed(1)} L ${wingB[0].toFixed(1)} ${wingB[1].toFixed(1)}`,
      delay: clock + STEP.shaft - 0.05,
      duration: STEP.head,
    });

    labelX = tailX;
    labelY = tailY + direction * 4;
    clock += STEP.shaft * 0.7;
  } else if (labelOnly) {
    labelX = tailFor(centreX);
    labelY = headY + direction * 4;
  }

  const label = annotation.label
    ? { text: annotation.label, x: labelX, y: labelY, above: direction < 0, delay: clock }
    : undefined;
  return { paths, label };
}

/** Total time one annotation takes to draw, used to queue several one after another. */
function drawDuration(annotation: BoardAnnotation): number {
  let total =
    annotation.kind === "circle"
      ? STEP.circle + STEP.circle * 0.55
      : annotation.kind === "underline"
        ? 0.55
        : 0;
  if (annotation.kind === "arrow" || (annotation.kind === "circle" && annotation.label)) total += STEP.shaft + STEP.head;
  if (annotation.label) total += 0.55;
  return total + 0.25;
}

export function AnnotationLayer({
  rootRef,
  annotations,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  annotations: BoardAnnotation[];
}) {
  const geometry = useAnnotationGeometry(rootRef, annotations);

  // Several annotations that appear together are drawn one after another (in the
  // order the tutor made them), like a hand moving from one mark to the next.
  const planned = useRef<Map<string, number>>(new Map());
  const queueFreeAt = useRef(0);

  const marks = useMemo(() => {
    if (!geometry) return [];
    const result: Array<{ annotation: BoardAnnotation; mark: Mark }> = [];
    const located = annotations.flatMap((annotation) => {
      const box = geometry.boxes[annotation.id];
      return box ? [{ annotation, box }] : [];
    });
    const tails = layoutTails(located, geometry);
    annotations.forEach((annotation) => {
      const box = geometry.boxes[annotation.id];
      if (!box) return;

      if (!planned.current.has(annotation.id)) {
        const now = performance.now();
        const start = Math.max(now, queueFreeAt.current);
        planned.current.set(annotation.id, (start - now) / 1000 + 0.2);
        queueFreeAt.current = start + drawDuration(annotation) * 1000;
      }
      result.push({
        annotation,
        mark: buildMark(annotation, box, geometry, tails.get(annotation.id), planned.current.get(annotation.id) ?? 0.2),
      });
    });
    return result;
  }, [annotations, geometry]);

  if (!geometry || !marks.length) return null;

  return (
    <div className="board-annotations" aria-hidden="true">
      <svg
        className="board-annot-svg"
        width={geometry.w}
        height={geometry.h}
        viewBox={`0 0 ${geometry.w} ${geometry.h}`}
      >
        {marks.map(({ annotation, mark }) => (
          <g key={annotation.id} style={{ color: CHALK[annotation.color] }}>
            {mark.paths.map((path, index) => (
              <path
                key={index}
                d={path.d}
                pathLength={1}
                className="annot-stroke"
                style={
                  {
                    animationDelay: `${path.delay.toFixed(2)}s`,
                    animationDuration: `${path.duration.toFixed(2)}s`,
                  } as CSSProperties
                }
              />
            ))}
          </g>
        ))}
      </svg>
      {marks.map(({ annotation, mark }) =>
        mark.label ? (
          <span
            key={`${annotation.id}-label`}
            className="board-annot-label chalk-hand-line is-ltr"
            style={{
              left: mark.label.x,
              top: mark.label.y,
              color: CHALK[annotation.color],
              transform: `translate(-50%, ${mark.label.above ? "-100%" : "0"})`,
              animationDelay: `${mark.label.delay.toFixed(2)}s`,
              animationDuration: `${Math.min(0.9, Math.max(0.4, mark.label.text.length * 0.05)).toFixed(2)}s`,
            }}
          >
            {mark.label.text}
          </span>
        ) : null,
      )}
    </div>
  );
}
