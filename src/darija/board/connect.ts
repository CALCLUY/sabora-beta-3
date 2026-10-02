/**
 * Cross-block connector arrows: flow ("step 1 → step 2") and reference-back
 * ("this step uses that rule") arrows between two blocks already on the board.
 * Pure logic shared by the tool handler and the renderer.
 */
import { hasArabicScript } from "./guard";
import { blockVisibleText, MAX_ACTIVE_ARROWS, normalizeMatchText } from "./annotate";
import type { BoardBlock, BoardConnector, ChalkColor } from "./types";

const MAX_LABEL_CHARS = 32;
const MAX_TARGET_CHARS = 40;

export { MAX_ACTIVE_ARROWS };

export function countActiveArrows(blocks: BoardBlock[], connectors: BoardConnector[]): number {
  const annotationArrows = blocks.reduce(
    (sum, block) => sum + (block.annotations?.filter((item) => item.kind === "arrow").length ?? 0),
    0,
  );
  return annotationArrows + connectors.length;
}

function createConnectorId(): string {
  return `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pickColor(value: unknown): ChalkColor {
  return value === "white" || value === "red" ? value : "yellow";
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}

function validateTarget(block: BoardBlock, target: string | undefined, occurrence: number): string | null {
  if (!target) return null; // anchoring on the block edge is always valid
  const needle = normalizeMatchText(target);
  const total = countOccurrences(normalizeMatchText(blockVisibleText(block)), needle);
  if (!needle || total === 0) {
    return `'${target}' is not visible in that block. The block shows: ${blockVisibleText(block).slice(0, 120)}`;
  }
  if (occurrence > total) return `'${target}' appears only ${total} time(s) in that block.`;
  return null;
}

export type ConnectResult =
  | { ok: true; connectors: BoardConnector[]; connector?: BoardConnector }
  | { ok: false; message: string };

function fail(message: string): ConnectResult {
  return { ok: false, message };
}

/** Removes connectors whose source or destination block no longer exists. */
export function pruneConnectors(connectors: BoardConnector[], blocks: BoardBlock[]): BoardConnector[] {
  if (!connectors.length) return connectors;
  const liveIds = new Set(blocks.map((block) => block.id));
  const next = connectors.filter((connector) => liveIds.has(connector.fromId) && liveIds.has(connector.toId));
  return next.length === connectors.length ? connectors : next;
}

export function applyBoardConnect(
  blocks: BoardBlock[],
  connectors: BoardConnector[],
  args: Record<string, unknown>,
): ConnectResult {
  if (args.kind === "clear") {
    const fromId = typeof args.fromId === "string" ? args.fromId : undefined;
    const toId = typeof args.toId === "string" ? args.toId : undefined;
    const next = connectors.filter((connector) => {
      if (fromId && connector.fromId !== fromId) return true;
      if (toId && connector.toId !== toId) return true;
      return !(fromId || toId);
    });
    return { ok: true, connectors: next, connector: next[0] ?? connectors[0] };
  }
  if (args.kind !== "flow") return fail("kind must be 'flow' or 'clear'.");

  const fromId = typeof args.fromId === "string" ? args.fromId.trim() : "";
  const toId = typeof args.toId === "string" ? args.toId.trim() : "";
  const rawFromTarget = typeof args.fromTarget === "string" ? args.fromTarget.trim() || undefined : undefined;
  const rawToTarget = typeof args.toTarget === "string" ? args.toTarget.trim() || undefined : undefined;
  const fromTarget = rawFromTarget ? rawFromTarget.replace(/^\$+|\$+$/g, "").trim() || undefined : undefined;
  const toTarget = rawToTarget ? rawToTarget.replace(/^\$+|\$+$/g, "").trim() || undefined : undefined;

  let fromBlock = fromId ? blocks.find((b) => b.id === fromId) : undefined;
  let toBlock = toId ? blocks.find((b) => b.id === toId) : undefined;

  // Resolve fromBlock by fromTarget if fromBlock wasn't found by exact id:
  if (!fromBlock && fromTarget) {
    const needle = normalizeMatchText(fromTarget);
    if (needle) {
      fromBlock = blocks.find((b) => b.type !== "question" && normalizeMatchText(blockVisibleText(b)).includes(needle));
    }
  }
  // Resolve toBlock by toTarget if toBlock wasn't found by exact id:
  if (!toBlock && toTarget) {
    const needle = normalizeMatchText(toTarget);
    if (needle) {
      toBlock = [...blocks].reverse().find((b) => b !== fromBlock && b.type !== "question" && normalizeMatchText(blockVisibleText(b)).includes(needle));
    }
  }

  // If still missing and aliases were used or omitted:
  const middleBlocks = blocks.filter((b) => b.zone === "middle" && b.type !== "question");
  if (!fromBlock && (fromId === "previous" || fromId === "last" || fromId === "rule" || fromId === "step1" || !fromId) && middleBlocks.length >= 2) {
    fromBlock = middleBlocks[middleBlocks.length - 2];
  }
  if (!toBlock && (toId === "current" || toId === "latest" || toId === "next" || toId === "last" || toId === "step2" || !toId) && middleBlocks.length >= 1) {
    toBlock = middleBlocks[middleBlocks.length - 1];
  }

  if (!fromBlock) return fail("Could not find the starting block to connect from.");
  if (!toBlock) return fail("Could not find the destination block to connect to.");
  if (fromBlock.id === toBlock.id) return fail("from and to must be two different blocks.");
  if (fromBlock.zone !== toBlock.zone) return fail("Both blocks must be in the same board zone.");
  if (fromBlock.type === "question" || toBlock.type === "question") return fail("Questions cannot be connected.");

  if (countActiveArrows(blocks, connectors) >= MAX_ACTIVE_ARROWS) {
    return fail(
      `The board already has ${MAX_ACTIVE_ARROWS} arrows — that is the limit before it turns into visual clutter. Clear one (board_annotate kind='clear' or board_connect kind='clear') before adding another.`,
    );
  }

  if (fromTarget && fromTarget.length > MAX_TARGET_CHARS) return fail(`fromTarget too long (max ${MAX_TARGET_CHARS} characters).`);
  if (toTarget && toTarget.length > MAX_TARGET_CHARS) return fail(`toTarget too long (max ${MAX_TARGET_CHARS} characters).`);

  const fromOccurrence = Math.max(1, Math.floor(typeof args.fromOccurrence === "number" ? args.fromOccurrence : 1));
  const toOccurrence = Math.max(1, Math.floor(typeof args.toOccurrence === "number" ? args.toOccurrence : 1));

  const fromError = validateTarget(fromBlock, fromTarget, fromOccurrence);
  if (fromError) return fail(`fromTarget: ${fromError}`);
  const toError = validateTarget(toBlock, toTarget, toOccurrence);
  if (toError) return fail(`toTarget: ${toError}`);

  let label = typeof args.label === "string" ? args.label.replace(/\s+/g, " ").trim().replace(/\s*[:：]\s*$/, "") : "";
  if (hasArabicScript(label)) return fail("Labels must be simple French only (or empty) — no Arabic.");
  if (label.length > MAX_LABEL_CHARS) return fail(`label too long (max ${MAX_LABEL_CHARS} characters).`);

  const connector: BoardConnector = {
    id: createConnectorId(),
    zone: fromBlock.zone,
    fromId,
    fromTarget,
    fromOccurrence,
    toId,
    toTarget,
    toOccurrence,
    label: label || undefined,
    color: pickColor(args.color),
    createdAt: Date.now(),
  };

  return { ok: true, connectors: [...connectors, connector], connector };
}

/* ------------------------------------------------------------------------ */
/* Layout & lifetime of connector arrows                                      */
/* ------------------------------------------------------------------------ */

export type ConnectorSide = "left" | "right";

/** Blocks older than this (counting back from the newest in their zone) drop their arrows. */
const CONNECTOR_LIFETIME_BLOCKS = 4;

/**
 * Arrows are teaching marks for what is being explained now: once the lesson has
 * moved on a few blocks, arrows whose ends have scrolled into the past disappear,
 * so the 3-arrow budget is never permanently used up by old material.
 */
export function expireStaleConnectors(connectors: BoardConnector[], blocks: BoardBlock[]): BoardConnector[] {
  if (!connectors.length) return connectors;
  const recent = new Set<string>();
  for (const zone of ["middle", "right"] as const) {
    blocks
      .filter((block) => block.zone === zone)
      .slice(-CONNECTOR_LIFETIME_BLOCKS)
      .forEach((block) => recent.add(block.id));
  }
  const next = connectors.filter((connector) => recent.has(connector.fromId) && recent.has(connector.toId));
  return next.length === connectors.length ? connectors : next;
}

/**
 * Chooses the margin (left / right) each connector runs through.
 *
 * Arrows are routed through a side margin as nested C-shapes. Two C-shapes on the
 * SAME side only avoid each other when their vertical spans are nested or disjoint —
 * if the spans interleave (a < c < b < d) they must cross. So interleaving arrows are
 * sent to opposite margins, which guarantees no two arrows ever cross.
 */
export function assignConnectorSides(
  connectors: BoardConnector[],
  blocks: BoardBlock[],
): Record<string, ConnectorSide> {
  const order = new Map(blocks.map((block, index) => [block.id, index]));
  const placed: Array<{ lo: number; hi: number; side: ConnectorSide }> = [];
  const result: Record<string, ConnectorSide> = {};

  const interleaves = (a: { lo: number; hi: number }, b: { lo: number; hi: number }) =>
    (a.lo < b.lo && b.lo < a.hi && a.hi < b.hi) || (b.lo < a.lo && a.lo < b.hi && b.hi < a.hi);

  for (const connector of connectors) {
    const a = order.get(connector.fromId) ?? 0;
    const b = order.get(connector.toId) ?? 0;
    const span = { lo: Math.min(a, b), hi: Math.max(a, b) };
    const blocked = (side: ConnectorSide) => placed.some((item) => item.side === side && interleaves(item, span));
    const side: ConnectorSide = !blocked("right") ? "right" : !blocked("left") ? "left" : "right";
    placed.push({ ...span, side });
    result[connector.id] = side;
  }
  return result;
}

/** Width of each side margin in em of the board's chalk font: room for the nested legs and labels. */
export function connectorGutters(
  connectors: BoardConnector[],
  sides: Record<string, ConnectorSide>,
): { left: number; right: number } {
  const total = { left: 0, right: 0 };
  for (const side of ["left", "right"] as const) {
    const mine = connectors.filter((connector) => sides[connector.id] === side);
    if (!mine.length) continue;
    // Each nested leg needs its own lane plus room for its label.
    const width = mine.reduce((sum, connector) => sum + 1.1 + (connector.label ? connector.label.length * 0.42 : 0), 1.0);
    total[side] = Math.min(12, Math.max(2.4, width));
  }
  return total;
}
