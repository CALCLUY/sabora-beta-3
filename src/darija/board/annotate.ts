/**
 * Board annotations: hand-drawn circles, labelled arrows and underlines that point
 * at a PART of a block already on the board (e.g. the "a" in  z = a + bi).
 *
 * The target is identified by its VISIBLE characters, so the same matching works
 * for plain text and for typeset LaTeX. This module holds the pure logic shared by
 * the tool handler (static validation) and the renderer (DOM lookup).
 */
import { hasArabicScript } from "./guard";
import type { AnnotationKind, BoardAnnotation, BoardBlock, ChalkColor } from "./types";

const LATEX_SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", theta: "θ", lambda: "λ", mu: "μ",
  pi: "π", rho: "ρ", sigma: "σ", omega: "ω", Delta: "Δ", Sigma: "Σ", Omega: "Ω",
  times: "×", cdot: "⋅", infty: "∞", leq: "≤", geq: "≥", neq: "≠", pm: "±",
  rightarrow: "→", to: "→", approx: "≈",
};

/** LaTeX source -> the characters a reader actually sees ("\frac{a}{b}" -> "ab"). */
export function latexToVisible(source: string): string {
  return source
    .replace(/\\([A-Za-z]+)/g, (_match, name: string) => LATEX_SYMBOLS[name] ?? "")
    .replace(/[{}^_$\\]/g, "");
}

/** Unifies dash / prime / dot variants so typed and typeset characters compare equal. */
export function mapMatchChar(ch: string): string {
  if (/[-–—−]/.test(ch)) return "−";
  if (/['’′`]/.test(ch)) return "′";
  if (ch === "·") return "⋅";
  return ch;
}

export function normalizeMatchText(value: string): string {
  return Array.from(latexToVisible(value))
    .filter((ch) => !/\s/.test(ch))
    .map(mapMatchChar)
    .join("");
}

/** Every character a block shows, in reading order (used to validate a target). */
export function blockVisibleText(block: BoardBlock): string {
  const parts: string[] = [];
  if (block.term) parts.push(block.term);
  if (block.title) parts.push(block.title);
  if (block.content) parts.push(block.content);
  if (block.items?.length) parts.push(...block.items);
  return parts.join(" ");
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

/**
 * Marks per block: enough to label a formula's two or three key symbols, few
 * enough that the block stays readable. Extra marks belong to the next thing
 * being explained, not on top of the current one.
 */
/** The parts of a block that render as mathematics: a formula block, or $...$ runs. */
export function mathRegionsOf(block: BoardBlock): string[] {
  if (block.type === "formula" || block.type === "latex") return [block.content];
  const sources = [block.content, ...(block.items ?? [])];
  const regions: string[] = [];
  for (const source of sources) {
    const pattern = /\$([^$\n]+)\$/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) regions.push(match[1]);
  }
  return regions;
}

/** How well a block matches a target: 3 = inside its maths, 1 = somewhere in its text. */
function targetScore(block: BoardBlock, needle: string): number {
  if (!needle) return 0;
  const inMath = mathRegionsOf(block).some((region) => normalizeMatchText(region).includes(needle));
  if (inMath) return 3;
  return normalizeMatchText(blockVisibleText(block)).includes(needle) ? 1 : 0;
}

export const MAX_ANNOTATIONS_PER_BLOCK = 3;
const MAX_LABEL_CHARS = 32;
const MAX_TARGET_CHARS = 40;

/**
 * Hard cap on how many arrows may exist on the whole board at once (single-block
 * arrow annotations + cross-block connectors combined): past 2-3, arrows stop
 * reading as meaningful and turn into visual noise. Shared with connect.ts.
 */
export const MAX_ACTIVE_ARROWS = 3;

export type AnnotateResult =
  | { ok: true; blocks: BoardBlock[]; blockId: string }
  | { ok: false; message: string };

function fail(message: string): AnnotateResult {
  return { ok: false, message };
}

function createAnnotationId(): string {
  return `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pickColor(value: unknown): ChalkColor {
  return value === "white" || value === "red" ? value : "yellow";
}

/**
 * Adds (or clears) an annotation on a block. Pure: returns the new block list.
 * With no `id` it targets the most recently written annotatable block.
 * `activeArrowCount` is the number of arrows already on the whole board
 * (other annotations + connectors combined) so the global arrow cap can be
 * enforced even though connectors live outside this module.
 */
export function applyBoardAnnotate(
  blocks: BoardBlock[],
  args: Record<string, unknown>,
  activeArrowCount = 0,
): AnnotateResult {
  const annotatable = (candidate: BoardBlock) => candidate.type !== "svg" && candidate.type !== "question";

  const rawTarget = typeof args.target === "string" ? args.target.trim() : "";
  const target = rawTarget.replace(/^\$+|\$+$/g, "").trim();
  const id = typeof args.id === "string" ? args.id.trim() : "";

  // 1. Try finding by explicit id:
  let found = id ? blocks.find((candidate) => candidate.id === id) : undefined;

  // 2. If id was omitted or unknown, choose the block that BEST matches the target:
  // a block whose rendered maths contains it beats one that merely has the letter
  // somewhere in a French sentence. Newest wins ties.
  if (!found && target) {
    const needle = normalizeMatchText(target);
    if (needle) {
      let best = 0;
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const candidate = blocks[i];
        if (!annotatable(candidate)) continue;
        const score = targetScore(candidate, needle);
        if (score > best) {
          best = score;
          found = candidate;
          if (score === 3) break;
        }
      }
    }
  }

  // 3. Fallback to the most recent annotatable block:
  if (!found) {
    found = [...blocks].reverse().find(annotatable);
  }

  if (!found) {
    return fail("Nothing on the board to annotate yet. Write the formula or text first with board_write.");
  }
  const block: BoardBlock = found;
  if (!annotatable(block)) return fail("Questions and diagrams cannot be annotated. Annotate a formula, definition or text block.");

  const kind = args.kind as AnnotationKind | "clear" | undefined;
  if (kind === "clear") {
    return {
      ok: true,
      blocks: blocks.map((candidate) => (candidate.id === block.id ? { ...candidate, annotations: undefined } : candidate)),
      blockId: block.id,
    };
  }
  if (kind !== "circle" && kind !== "arrow" && kind !== "underline") {
    return fail("kind must be 'circle', 'arrow', 'underline' or 'clear'.");
  }
  if (kind === "arrow" && activeArrowCount >= MAX_ACTIVE_ARROWS) {
    return fail(
      `The board already has ${MAX_ACTIVE_ARROWS} arrows — that is the limit before it turns into visual clutter. Clear one first (kind='clear'), or use kind='circle'/'underline' instead if you only need to flag a detail.`,
    );
  }

  if (!target) return fail("target is required: the exact visible characters to point at (e.g. 'a' or 'bi').");
  if (target.length > MAX_TARGET_CHARS) return fail(`target too long (max ${MAX_TARGET_CHARS} characters). Point at one small part.`);

  let label = typeof args.label === "string" ? args.label.replace(/\s+/g, " ").trim().replace(/\s*[:：]\s*$/, "") : "";
  if (hasArabicScript(label)) {
    return fail("Labels must be 1-3 words of simple French only — no Arabic. Say the Darija explanation aloud instead.");
  }
  if (label.length > MAX_LABEL_CHARS) return fail(`label too long (max ${MAX_LABEL_CHARS} characters). Use 1-3 simple French words.`);
  label = label.trim();

  const within = typeof args.within === "string" ? args.within.replace(/^\$+|\$+$/g, "").trim() : "";
  const needle = normalizeMatchText(target);
  const haystack = normalizeMatchText(blockVisibleText(block));
  const total = countOccurrences(haystack, needle);
  const occurrence = Math.max(1, Math.floor(typeof args.occurrence === "number" ? args.occurrence : 1));
  if (!needle || total === 0) {
    return fail(
      `The text '${target}' is not visible in that block. Give the exact visible characters as displayed (no LaTeX commands; write Greek letters as α, β…). The block shows: ${blockVisibleText(block).slice(0, 120)}`,
    );
  }
  if (occurrence > total) {
    return fail(`'${target}' appears only ${total} time(s) in that block; occurrence ${occurrence} does not exist.`);
  }

  // AMBIGUITY GUARD: a bare letter that appears all over a French sentence and is
  // NOT inside any formula would land on the wrong character. Refuse and explain.
  const mathHasTarget = mathRegionsOf(block).some((region) => normalizeMatchText(region).includes(needle));
  const withinOk = within ? normalizeMatchText(blockVisibleText(block)).includes(normalizeMatchText(within)) : false;
  if (needle.length <= 2 && !mathHasTarget && !withinOk && total > 1) {
    return fail(
      `'${target}' appears ${total} times in that block and is not inside a formula, so the mark would land on the wrong character. ` +
        "Fix it one of two ways: (1) write the equation as its own block first — board_write(type='formula', content='z = a + ib') — then annotate that; or (2) pass within='<the surrounding expression>' (e.g. within='z = a + ib', target='a').",
    );
  }

  const existing = block.annotations ?? [];
  if (existing.length >= MAX_ANNOTATIONS_PER_BLOCK) {
    return fail(
      `This block already has ${MAX_ANNOTATIONS_PER_BLOCK} marks — a block should show only the 2-3 pieces you are explaining right now. Do not add more: either clear (kind='clear') the mark whose point you already made, or move on to the next block.`,
    );
  }
  if (existing.some((item) => item.kind === kind && item.occurrence === occurrence && normalizeMatchText(item.target) === needle)) {
    return fail("That part is already annotated this way.");
  }

  // Neighbouring targets (a / bi in  z = a + bi) must not share a side, or their
  // labels collide: alternate automatically unless the tutor chose a side.
  const below = existing.filter((item) => item.side === "below").length;
  const above = existing.filter((item) => item.side === "above").length;
  const side: BoardAnnotation["side"] =
    args.side === "above" || args.side === "below" ? args.side : below <= above ? "below" : "above";

  const annotation: BoardAnnotation = {
    id: createAnnotationId(),
    kind,
    target,
    occurrence,
    within: within || undefined,
    label: label || undefined,
    side,
    color: pickColor(args.color),
    createdAt: Date.now(),
  };

  return {
    ok: true,
    blocks: blocks.map((candidate) =>
      candidate.id === block.id ? { ...candidate, annotations: [...existing, annotation] } : candidate,
    ),
    blockId: block.id,
  };
}
