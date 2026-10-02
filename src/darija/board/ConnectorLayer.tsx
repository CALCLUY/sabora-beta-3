"use client";

import { useEffect, useMemo, useState, type CSSProperties, type RefObject } from "react";
import { findBoxRelativeTo, hashString, seededRandom, type Box } from "./boardDom";
import type { ConnectorSide } from "./connect";
import type { BoardConnector, ChalkColor } from "./types";

/**
 * Hand-drawn arrows linking one block to another inside a zone — a flow ("step 1 →
 * step 2") or a reference back to a rule already on the board.
 *
 * Routing: instead of a straight line cutting across the text (and across other
 * arrows), every arrow leaves its block at the edge, runs out into a side margin as a
 * smooth "C", and comes back in at the destination. Arrows are nested by length (short
 * ones closest to the text), and arrows whose spans would interleave are sent to opposite
 * margins (see assignConnectorSides) — that is what guarantees they never cross.
 */

const CHALK: Record<ChalkColor, string> = { white: "#fdf7e6", yellow: "#ffe066", red: "#ff5b61", blue: "#7ec8ff" };

type Anchor = { x: number; y: number };
type Geometry = {
  w: number;
  h: number;
  /** Chalk font size in px, used for spacing so the layout scales with the board. */
  fs: number;
  contentLeft: number;
  contentRight: number;
  ends: Record<string, { from: Box; to: Box; fromY: number; toY: number } | null>;
};

function useConnectorGeometry(zoneRef: RefObject<HTMLDivElement | null>, connectors: BoardConnector[]) {
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone || !connectors.length) {
      setGeometry(null);
      return undefined;
    }
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;
      const round = (value: number) => Math.round(value * 2) / 2;
      const style = getComputedStyle(zone);
      const chalk = zone.querySelector<HTMLElement>(".board-block");
      const fs = chalk ? parseFloat(getComputedStyle(chalk).fontSize) || 18 : 18;

      // Several arrows may attach to the same block (a chain: 1 → 2 → 3). Fan their
      // attachment points out vertically so two arrows never start at the same spot.
      const uses = new Map<string, string[]>();
      for (const connector of connectors) {
        for (const key of [`${connector.fromId}|from|${connector.id}`, `${connector.toId}|to|${connector.id}`]) {
          const blockId = key.split("|")[0];
          uses.set(blockId, [...(uses.get(blockId) ?? []), key]);
        }
      }
      const fanOffset = (blockId: string, key: string, blockHeight: number) => {
        const list = uses.get(blockId) ?? [];
        if (list.length < 2) return 0;
        const step = Math.min(fs * 0.75, Math.max(0, blockHeight - 10) / (list.length - 1));
        return (list.indexOf(key) - (list.length - 1) / 2) * step;
      };

      const ends: Geometry["ends"] = {};
      for (const connector of connectors) {
        const fromEl = zone.querySelector<HTMLElement>(`[data-block-id="${connector.fromId}"]`);
        const toEl = zone.querySelector<HTMLElement>(`[data-block-id="${connector.toId}"]`);
        if (!fromEl || !toEl) {
          ends[connector.id] = null;
          continue;
        }
        // Anchor on the block's edge; a target only decides WHICH LINE the arrow meets.
        const from = findBoxRelativeTo(fromEl, zone, undefined, 1);
        const to = findBoxRelativeTo(toEl, zone, undefined, 1);
        if (!from || !to) {
          ends[connector.id] = null;
          continue;
        }
        const fromHit = connector.fromTarget ? findBoxRelativeTo(fromEl, zone, connector.fromTarget, connector.fromOccurrence) : null;
        const toHit = connector.toTarget ? findBoxRelativeTo(toEl, zone, connector.toTarget, connector.toOccurrence) : null;
        const fromOffset = fanOffset(connector.fromId, `${connector.fromId}|from|${connector.id}`, from.h);
        const toOffset = fanOffset(connector.toId, `${connector.toId}|to|${connector.id}`, to.h);
        ends[connector.id] = {
          from,
          to,
          fromY: round((fromHit ? fromHit.y + fromHit.h / 2 : from.y + from.h / 2) + fromOffset),
          toY: round((toHit ? toHit.y + toHit.h / 2 : to.y + to.h / 2) + toOffset),
        };
      }

      const next: Geometry = {
        w: round(zone.scrollWidth),
        h: round(zone.scrollHeight),
        fs: round(fs),
        contentLeft: round(parseFloat(style.paddingLeft) || 0),
        contentRight: round(zone.clientWidth - (parseFloat(style.paddingRight) || 0)),
        ends,
      };
      setGeometry((previous) => (previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(zone);
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(() => measure()).catch(() => {});
    }
    const timer = window.setTimeout(measure, 200);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [zoneRef, connectors]);

  return geometry;
}

type Built = {
  paths: Array<{ d: string; delay: number; duration: number }>;
  label?: { text: string; x: number; y: number; side: ConnectorSide; delay: number };
  duration: number;
};

function buildRoute(
  connector: BoardConnector,
  side: ConnectorSide,
  lane: number,
  ends: NonNullable<Geometry["ends"][string]>,
  geometry: Geometry,
  delay: number,
): Built {
  const random = seededRandom(hashString(connector.id));
  const { fs } = geometry;
  const gap = 4;

  const right = side === "right";
  const start: Anchor = { x: right ? ends.from.x + ends.from.w + gap : ends.from.x - gap, y: ends.fromY + (random() - 0.5) * 2 };
  const end: Anchor = { x: right ? ends.to.x + ends.to.w + gap : ends.to.x - gap, y: ends.toY + (random() - 0.5) * 2 };

  // The outermost point of the "C" sits in this arrow's own lane of the margin.
  const laneX = right ? geometry.contentRight + lane : geometry.contentLeft - lane;
  // A cubic whose two control points share one x reaches 0.75*cx + 0.125*(sx+ex) at its apex.
  const controlX = (laneX - 0.125 * (start.x + end.x)) / 0.75;
  const d = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${controlX.toFixed(1)} ${start.y.toFixed(1)} ${controlX.toFixed(1)} ${end.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;

  const span = Math.abs(end.y - start.y);
  const shaftDuration = Math.min(1.5, Math.max(0.55, (span + Math.abs(laneX - start.x) * 2) / (fs * 9)));

  // The arrowhead points back into the block, along the final horizontal run.
  const angle = right ? Math.PI : 0;
  const wing = Math.max(8, fs * 0.42);
  const wingA: Anchor = { x: end.x - wing * Math.cos(angle - 0.5), y: end.y - wing * Math.sin(angle - 0.5) };
  const wingB: Anchor = { x: end.x - wing * Math.cos(angle + 0.5), y: end.y - wing * Math.sin(angle + 0.5) };

  const paths = [
    { d, delay, duration: shaftDuration },
    {
      d: `M ${wingA.x.toFixed(1)} ${wingA.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)} L ${wingB.x.toFixed(1)} ${wingB.y.toFixed(1)}`,
      delay: delay + shaftDuration - 0.05,
      duration: 0.2,
    },
  ];

  // The label sits just OUTSIDE the vertical leg, in the margin — never over the text.
  const label = connector.label
    ? {
        text: connector.label,
        x: laneX + (right ? fs * 0.35 : -fs * 0.35),
        y: (start.y + end.y) / 2,
        side,
        delay: delay + shaftDuration * 0.5,
      }
    : undefined;
  return { paths, label, duration: shaftDuration + 0.2 };
}

export function ConnectorLayer({
  zoneRef,
  connectors,
  sides,
}: {
  zoneRef: RefObject<HTMLDivElement | null>;
  connectors: BoardConnector[];
  sides: Record<string, ConnectorSide>;
}) {
  const geometry = useConnectorGeometry(zoneRef, connectors);

  const marks = useMemo(() => {
    if (!geometry) return [];
    const { fs } = geometry;

    // Nest per side: the shortest arrow gets the lane closest to the text; every
    // lane after it starts beyond the previous arrow's label, so nothing overlaps.
    const lanes = new Map<string, number>();
    for (const side of ["left", "right"] as const) {
      const mine = connectors
        .filter((connector) => (sides[connector.id] ?? "right") === side && geometry.ends[connector.id])
        .map((connector) => {
          const ends = geometry.ends[connector.id]!;
          return { connector, span: Math.abs(ends.toY - ends.fromY) };
        })
        .sort((a, b) => a.span - b.span);
      let lane = fs * 0.7;
      for (const item of mine) {
        lanes.set(item.connector.id, lane);
        const labelWidth = item.connector.label ? item.connector.label.length * fs * 0.42 : 0;
        lane += fs * 0.35 + labelWidth + fs * 0.8;
      }
    }

    // Draw one after another, like a teacher moving from one arrow to the next.
    let clock = 0.15;
    const result: Array<{ connector: BoardConnector; built: Built }> = [];
    for (const connector of connectors) {
      const ends = geometry.ends[connector.id];
      if (!ends) continue;
      const built = buildRoute(connector, sides[connector.id] ?? "right", lanes.get(connector.id) ?? fs, ends, geometry, clock);
      clock += built.duration + 0.35;
      result.push({ connector, built });
    }
    return result;
  }, [connectors, geometry, sides]);

  if (!geometry || !marks.length) return null;

  return (
    <div className="board-connectors" aria-hidden="true">
      <svg className="board-annot-svg" width={geometry.w} height={geometry.h} viewBox={`0 0 ${geometry.w} ${geometry.h}`}>
        {marks.map(({ connector, built }) => (
          <g key={connector.id} style={{ color: CHALK[connector.color] }}>
            {built.paths.map((path, index) => (
              <path
                key={index}
                d={path.d}
                pathLength={1}
                className="annot-stroke"
                style={{ animationDelay: `${path.delay.toFixed(2)}s`, animationDuration: `${path.duration.toFixed(2)}s` } as CSSProperties}
              />
            ))}
          </g>
        ))}
      </svg>
      {marks.map(({ connector, built }) =>
        built.label ? (
          <span
            key={`${connector.id}-label`}
            className="board-annot-label board-connector-label chalk-hand-line is-ltr"
            style={{
              left: built.label.x,
              top: built.label.y,
              color: CHALK[connector.color],
              transform: built.label.side === "right" ? "translate(0, -50%)" : "translate(-100%, -50%)",
              animationDelay: `${built.label.delay.toFixed(2)}s`,
              animationDuration: `${Math.min(0.9, Math.max(0.4, built.label.text.length * 0.05)).toFixed(2)}s`,
            }}
          >
            {built.label.text}
          </span>
        ) : null,
      )}
    </div>
  );
}
