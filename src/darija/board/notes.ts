/**
 * Turns what is on the board into plain-text study notes the student can keep.
 * Only the formal course content is exported (definitions, formulas, steps,
 * final answers, darija examples) — not the transient question callouts.
 */
import type { BoardBlock } from "./types";

function blockToLines(block: BoardBlock): string[] {
  switch (block.type) {
    case "heading":
      return ["", `# ${block.content}`, ""];
    case "objective":
    case "list": {
      const items = block.items?.length ? block.items : block.content ? [block.content] : [];
      return items.map((item) => `- ${item}`);
    }
    case "definition":
      return [`**${block.term ?? "Définition"}** : ${block.content}`];
    case "formula":
    case "latex":
      return [`$$ ${block.content} $$`];
    case "takeaway":
      return [`=> ${block.content}`];
    case "example": {
      const title = block.title ? `Exemple de ${block.title}` : "Exemple";
      return [`${title} :`, block.items?.length ? block.items.join("\n") : block.content];
    }
    case "question":
    case "svg":
      return [];
    default:
      return [block.content];
  }
}

export function boardToNotes(blocks: BoardBlock[], title = "Notes du cours"): string {
  const body = blocks.flatMap(blockToLines).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return "";
  const date = new Date().toLocaleDateString("fr-FR");
  return `${title} — ${date}\n${"=".repeat(24)}\n${body}\n`;
}
