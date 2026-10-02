/**
 * Fallback / automatic blackboard sync.
 *
 * IMPORTANT: this NEVER writes to the 'right' zone. The right zone is reserved
 * exclusively for real examples created by an explicit board_write(type="example")
 * tool call. Spoken transcript sentences must never be dumped there — otherwise
 * ordinary speech ends up rendered as "Exemple de … :".
 *
 * This only rescues, into the middle zone, what the model forgot to call a tool
 * for: a question actually asked out loud, one formula, or one numbered step /
 * stated conclusion. Never more than two rescue blocks per turn.
 */
import { applyBoardWrite } from "./state";
import type { BoardBlock } from "./types";

const LATEX_PATTERNS = [
  /\$\$([^$]+)\$\$/g,
  /\$([^$\n]{3,})\$/g,
  /\\\[([\s\S]+?)\\\]/g,
  /\\\(([\s\S]+?)\\\)/g,
];

export function extractBoardBlocksFromTranscript(
  transcript: string,
  existingBlocks: BoardBlock[],
): BoardBlock[] {
  if (!transcript || transcript.length < 15) return existingBlocks;

  let currentBlocks = [...existingBlocks];
  const existingContents = new Set(existingBlocks.map((b) => b.content.trim().toLowerCase()));
  // Fallback must never recreate a lecture transcript: at most one question and
  // one formal (formula/step/conclusion) rescue block per turn.
  let fallbackWrites = 0;

  // 1. Explicit LaTeX formulas ($...$, $$...$$, \[...\], \(...\)) -> formal zone.
  for (const pattern of LATEX_PATTERNS) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(transcript)) !== null) {
      const formula = match[1].trim();
      if (
        fallbackWrites < 1 &&
        formula.length >= 3 &&
        !/[\u0600-\u06FF]/.test(formula) &&
        !existingContents.has(formula.toLowerCase())
      ) {
        existingContents.add(formula.toLowerCase());
        const { blocks } = applyBoardWrite(currentBlocks, {
          zone: "middle",
          type: "formula",
          content: formula,
        });
        currentBlocks = blocks;
        fallbackWrites += 1;
      }
    }
  }

  // 2. A question actually asked out loud -> question block on the formal zone.
  //    Board questions are simple French only: a spoken Darija question stays
  //    spoken (the tutor is told to board its simple French version itself).
  const lines = transcript.split(/\r?\n|(?<=[.!?])\s+(?=[0-9]+[-.)]\s)/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!/[?؟]\s*$/.test(line)) continue;
    if (/[\u0600-\u06FF]/.test(line)) continue;
    if (line.length < 8 || line.length > 200) continue;
    if (existingContents.has(line.toLowerCase())) continue;
    if (currentBlocks.some((block) => block.type === "question")) break;

    existingContents.add(line.toLowerCase());
    const { blocks } = applyBoardWrite(currentBlocks, {
      zone: "middle",
      type: "question",
      content: line.replace(/^(?:question|q(?:uestion)?\s*\d*)\s*[:：]\s*/i, ""),
    });
    currentBlocks = blocks;
    fallbackWrites += 1;
    break;
  }

  // 3. Formal French-only steps / stated conclusions -> formal zone.
  //    Anything containing Arabic is spoken darija: it stays spoken, never boarded.
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/[\u0600-\u06FF]/.test(line)) continue;

    const isStep = /^(?:[0-9]+[-.)]\s*|[-•*]\s*)/.test(line);
    const isTakeaway = /^(?:Remarque|Conclusion|Formule|Résultat|Réponse)\s*[:：]/i.test(line);
    if (fallbackWrites >= 2) break;
    if (!isStep && !isTakeaway) continue;
    if (line.length < 10 || line.length > 220) continue;
    if (existingContents.has(line.toLowerCase())) continue;

    existingContents.add(line.toLowerCase());
    const { blocks } = applyBoardWrite(currentBlocks, {
      zone: "middle",
      type: isTakeaway ? "takeaway" : "text",
      content: line,
    });
    currentBlocks = blocks;
    fallbackWrites += 1;
  }

  return currentBlocks;
}
