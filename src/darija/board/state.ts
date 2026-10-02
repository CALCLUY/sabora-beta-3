/**
 * Board state helpers. Semantic block types enforce the classroom palette:
 * white = normal copy, yellow = headings/key terms, red = final answers and
 * formula warning symbols. Definitions/formulas get measured frames; objectives
 * and examples stay unframed.
 */
import type { BoardBlock, BoardBlockType, BoardZone, ChalkColor } from "./types";

const MAX_CONTENT_CHARS = 4_000;
// Budgets are in rendered "lines". Sized for the 1.5x chalk at a fixed 20:9 board,
// so a zone wipes itself right when it genuinely runs out of space.
const ZONE_INK_BUDGET: Record<BoardZone, number> = { left: 0, middle: 15, right: 13 };

function createBlockId(): string {
  return `blk-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeZone(value: unknown): BoardZone {
  return value === "right" ? "right" : "middle";
}

function normalizeType(value: unknown): BoardBlockType {
  return value === "heading" ||
    value === "objective" ||
    value === "definition" ||
    value === "text" ||
    value === "latex" ||
    value === "formula" ||
    value === "svg" ||
    value === "list" ||
    value === "example" ||
    value === "takeaway" ||
    value === "question"
    ? value
    : "text";
}

const RESULT_PATTERN = /(conclusion|résultat final|réponse finale|solution finale|final answer|answer:|à retenir|takeaway|الجواب النهائي|الخلاصة)/i;

/** Smart colors: title/key term yellow; one red accent for final answers; all other content white. */
export function pickSmartColor(type: BoardBlockType, content: string): ChalkColor {
  if (type === "heading") return "yellow";
  // Questions get their own reserved colour so they are unmistakable.
  if (type === "question") return "blue";
  if (type === "takeaway" || RESULT_PATTERN.test(content)) return "red";
  // Formulas remain white. A red symbol is applied only through accentSymbols.
  return "white";
}

export type BoardWriteArgs = {
  zone?: unknown;
  type?: unknown;
  content?: unknown;
  items?: unknown;
  title?: unknown;
  term?: unknown;
  accentSymbols?: unknown;
  color?: unknown;
  boxed?: unknown;
  underline?: unknown;
  large?: unknown;
};

function normalizeAccentSymbols(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const safe = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    // Only allow one-character variables or a Greek command name (without a leading backslash).
    .filter((item) => /^[A-Za-z]$/.test(item) || /^(?:alpha|beta|gamma|delta|theta|lambda|mu|rho|sigma|omega|Delta|Sigma|Omega)$/.test(item))
    .slice(0, 3);
  return safe.length ? safe : undefined;
}

const ARABIC_SCRIPT = /[\u0600-\u06FF]/u;

export function makeBoardBlock(args: BoardWriteArgs): BoardBlock {
  let zone = normalizeZone(args.zone);
  let type = normalizeType(args.type);
  if (zone === "right" && (type === "text" || type === "list")) type = "example";
  const content = typeof args.content === "string" ? args.content.slice(0, MAX_CONTENT_CHARS) : "";
  if (type === "text" && RESULT_PATTERN.test(content)) type = "takeaway";
  const items = Array.isArray(args.items) ? args.items.map((item) => String(item)).slice(0, 24) : undefined;
  const term = typeof args.term === "string" && args.term.trim() ? args.term.trim().slice(0, 120) : undefined;

  // Safety net: Arabic content must NEVER render as a formal/boxed block in the
  // large zone. If it slips past the tool-level rejection, reroute it to the
  // right zone and render it as a plain (unframed) example instead.
  if (
    zone === "middle" &&
    type !== "question" &&
    ARABIC_SCRIPT.test(`${content} ${items?.join(" ") ?? ""} ${term ?? ""}`)
  ) {
    zone = "right";
    if (type !== "example") type = "example";
  }

  // Semantic rules override model flags so roles always look consistent.
  // Frames are reserved for what students hunt for when reviewing: definitions,
  // final answers, and ONLY the key formula the model explicitly marks boxed=true.
  // Worked steps, substitutions and example values stay unframed.
  const boxed =
    type === "definition" ||
    type === "takeaway" ||
    ((type === "latex" || type === "formula") && args.boxed === true);
  const underline = type === "heading" || type === "takeaway" || Boolean(args.underline);
  const large = type === "heading" || Boolean(args.large);
  const color = pickSmartColor(type, content);

  return {
    id: createBlockId(),
    zone,
    type,
    content,
    items,
    title: typeof args.title === "string" && args.title.trim() ? args.title.trim().slice(0, 120) : undefined,
    term,
    accentSymbols: normalizeAccentSymbols(args.accentSymbols),
    color,
    boxed,
    underline,
    large,
    createdAt: Date.now(),
  };
}

export function estimateInk(block: BoardBlock): number {
  // Chars per rendered line at the 1.5x chalk size on a 20:9 board.
  const charsPerLine = block.zone === "right" ? 30 : 52;
  const scale = block.large ? 1.5 : 1;
  let lines: number;
  switch (block.type) {
    case "svg":
      lines = 6;
      break;
    case "latex":
    case "formula":
      lines = 2 + Math.floor(block.content.length / 80);
      break;
    case "list":
    case "objective":
      lines = (block.items ?? []).reduce((sum, item) => sum + Math.max(1, Math.ceil(item.length / charsPerLine)), 0);
      break;
    case "example":
      lines = 1.2 + Math.max(1, Math.ceil(block.content.length / charsPerLine));
      break;
    default:
      lines = Math.max(1, Math.ceil(block.content.length / charsPerLine));
  }
  // Annotations reserve a band above and/or below the block for arrows and labels.
  const annotationBands =
    (block.annotations?.some((item) => item.side === "above") ? 1 : 0) +
    (block.annotations?.some((item) => item.side === "below") ? 1 : 0);
  return (lines + (block.boxed ? 1 : 0)) * scale + 0.5 + annotationBands * 1.1;
}

function zoneInk(blocks: BoardBlock[]): number {
  return blocks.reduce((sum, block) => sum + estimateInk(block), 0);
}

/**
 * Annotations are teaching marks for what is being explained RIGHT NOW: as soon
 * as the tutor moves on (writes the next block in the zone), the marks on older
 * blocks expire. The two most recent blocks keep theirs so a formula plus its
 * example stay annotated together; older ones go back to plain chalk.
 */
function expireStaleAnnotations(current: BoardBlock[]): BoardBlock[] {
  const markable = current.filter((item) => item.annotations?.length);
  if (markable.length <= 2) return current;
  const keep = new Set(markable.slice(-2).map((item) => item.id));
  return current.map((item) =>
    item.annotations?.length && !keep.has(item.id) ? { ...item, annotations: undefined } : item,
  );
}

/**
 * Normalized body text for duplicate detection: unifies case, diacritics and
 * Arabic letter variants, and strips punctuation, so retries with trivial
 * differences still match.
 */
function normalizeCompareText(text: string): string {
  return text
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type DuplicateCandidate = {
  type?: unknown;
  zone?: unknown;
  content?: unknown;
  items?: unknown;
  title?: unknown;
};

function candidateBodyText(c: DuplicateCandidate): string {
  const content = typeof c.content === "string" ? c.content : "";
  const items = Array.isArray(c.items) ? c.items.map((i) => String(i)).join(" ") : "";
  return `${content} ${items}`.trim();
}

function candidateZone(c: DuplicateCandidate): BoardZone {
  return c.zone === "right" ? "right" : "middle";
}

function candidateType(c: DuplicateCandidate): string {
  const t = typeof c.type === "string" ? c.type : "";
  // Right-zone text/list render as examples; match them as examples.
  if (candidateZone(c) === "right" && (t === "text" || t === "list")) return "example";
  return t;
}

/**
 * True when two same-zone, same-type bodies are the same content twice: exact
 * match after normalization, near-verbatim containment, or very high word
 * overlap (paraphrased retry). Questions are excluded (replace semantics).
 */
export function isDuplicateBody(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  if (candidateZone(a) !== candidateZone(b)) return false;
  const aType = candidateType(a);
  if (!aType || aType !== candidateType(b) || aType === "question") return false;
  const ka = normalizeCompareText(candidateBodyText(a));
  const kb = normalizeCompareText(candidateBodyText(b));
  if (ka.length < 12 || kb.length < 12) return false;
  if (ka === kb) return true;
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (shorter.length >= 40 && longer.includes(shorter) && shorter.length / longer.length >= 0.85) {
    return true;
  }
  const aWords = new Set(ka.split(" ").filter((w) => w.length > 1));
  const bWords = new Set(kb.split(" ").filter((w) => w.length > 1));
  const minSize = Math.min(aWords.size, bWords.size);
  if (minSize >= 8) {
    let shared = 0;
    for (const w of aWords) if (bWords.has(w)) shared += 1;
    if (shared / minSize >= 0.9) return true;
  }
  return false;
}

/** Finds an existing block duplicating the candidate, if any. */
export function findDuplicateBlock(
  blocks: BoardBlock[],
  candidate: DuplicateCandidate,
): BoardBlock | null {
  for (const existing of blocks) {
    if (
      isDuplicateBody(
        {
          type: existing.type,
          zone: existing.zone,
          content: existing.content,
          items: existing.items,
          title: existing.title,
        },
        candidate,
      )
    ) {
      return existing;
    }
  }
  return null;
}

/** Picks the oldest, least-important block to erase first: non-boxed, non-heading, non-question. */
function pickErasureVictim(current: BoardBlock[]): BoardBlock | null {
  const preferred = current
    .filter((b) => !b.boxed && b.type !== "question" && b.type !== "heading")
    .sort((a, b) => a.createdAt - b.createdAt);
  if (preferred.length) return preferred[0];
  const fallback = current.filter((b) => b.type !== "question").sort((a, b) => a.createdAt - b.createdAt);
  return fallback[0] ?? null;
}

/** Trim a zone's oldest (least important) blocks until it fits the ink budget. */
function trimZoneToFit(zoneBlocks: BoardBlock[], budget: number): BoardBlock[] {
  let current = zoneBlocks;
  while (current.length > 1 && zoneInk(current) > budget) {
    const victim = pickErasureVictim(current);
    if (!victim) break;
    current = current.filter((b) => b.id !== victim.id);
  }
  return current;
}

/**
 * Inserts an already-created block: question replacement + stale-annotation
 * expiry + append, then AUTO-ERASES the zone's oldest (least important) blocks
 * until the ink budget fits. This is what prevents the "board fills and stops"
 * dead-end: instead of blocking on the student for permission, the zone simply
 * recycles its oldest content so teaching keeps flowing.
 */
export function insertPreparedBlock(blocks: BoardBlock[], block: BoardBlock): BoardBlock[] {
  const others = blocks.filter((existing) => existing.zone !== block.zone);
  let current = expireStaleAnnotations(blocks.filter((existing) => existing.zone === block.zone));
  if (block.type === "question") {
    if (ARABIC_SCRIPT.test(block.content)) return blocks;
    return [...others, ...current.filter((existing) => existing.type !== "question"), block];
  }
  current = trimZoneToFit([...current, block], ZONE_INK_BUDGET[block.zone]);
  current.sort((a, b) => a.createdAt - b.createdAt);
  return [...others, ...current];
}

export type PreparedWrite =
  | { status: "ok"; block: BoardBlock }
  | { status: "duplicate"; existing: BoardBlock; block: BoardBlock };

/**
 * Validates a write against visible + already-queued blocks WITHOUT committing:
 * builds the block and rejects duplicates. Overflow is never a rejection — the
 * zone auto-erases its oldest content on insert, so there is no "full" state.
 */
export function prepareBoardWrite(
  visibleBlocks: BoardBlock[],
  queuedBlocks: BoardBlock[],
  args: BoardWriteArgs,
): PreparedWrite {
  const block = makeBoardBlock(args);
  const combined = [...visibleBlocks, ...queuedBlocks];
  const dupe = findDuplicateBlock(
    combined.filter((b) => b.zone === block.zone),
    {
      type: block.type,
      zone: block.zone,
      content: block.content,
      items: block.items,
      title: block.title,
    },
  );
  if (dupe) return { status: "duplicate", existing: dupe, block };
  return { status: "ok", block };
}

/**
 * Appends a block, refusing duplicates and auto-erasing the zone's oldest
 * content when it is full, so the board never blocks teaching on a prompt.
 */
export function applyBoardWrite(
  blocks: BoardBlock[],
  args: BoardWriteArgs,
): { blocks: BoardBlock[]; block: BoardBlock; erased: boolean; duplicate: boolean } {
  const block = makeBoardBlock(args);
  const dupe = findDuplicateBlock(
    blocks.filter((b) => b.zone === block.zone),
    {
      type: block.type,
      zone: block.zone,
      content: block.content,
      items: block.items,
      title: block.title,
    },
  );
  if (dupe) return { blocks, block: dupe, erased: false, duplicate: true };
  const before = new Set(blocks.map((b) => b.id));
  const next = insertPreparedBlock(blocks, block);
  const erased = [...before].some((id) => !next.some((b) => b.id === id));
  return { blocks: next, block, erased, duplicate: false };
}



/**
 * Which blocks to drop first when a zone physically overflows: transient
 * questions first, then unframed scratch content, and framed definitions /
 * formulas / final answers last — so lesson content survives as long as possible.
 */
export function pickErasable(blocks: BoardBlock[], count: number): string[] {
  if (count <= 0) return [];
  const rank = (block: BoardBlock) => (block.type === "question" ? 0 : block.boxed ? 2 : 1);
  return blocks
    .map((block, index) => ({ block, index, rank: rank(block) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, count)
    .map((entry) => entry.block.id);
}

export function applyBoardClear(blocks: BoardBlock[], zoneArg: unknown): BoardBlock[] {
  if (zoneArg === "left" || zoneArg === "middle" || zoneArg === "right") {
    return blocks.filter((block) => block.zone !== zoneArg);
  }
  return [];
}

export function applyBoardRemove(blocks: BoardBlock[], idArg: unknown): BoardBlock[] {
  if (typeof idArg !== "string") return blocks;
  return blocks.filter((block) => block.id !== idArg);
}

export function replaceZone(blocks: BoardBlock[], zone: BoardZone, zoneBlocks: BoardBlock[]): BoardBlock[] {
  return [...blocks.filter((block) => block.zone !== zone), ...zoneBlocks];
}
