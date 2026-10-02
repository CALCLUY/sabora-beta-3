/** Auto-populates the large formal zone from a PDF analysis. */
import type { DocumentAnalysis } from "../pdf/analyze";
import { makeBoardBlock } from "./state";
import type { BoardBlock } from "./types";

/**
 * Large merged zone: exam-style French content, semantically colored and framed.
 * Shows the lesson title plus the COMPLETE numbered roadmap (every teaching
 * point), so the learner sees from the start that nothing will be skipped.
 * Formulas arrive per-point as the lesson progresses instead of flooding the board.
 */
export function buildFormalZoneFromAnalysis(analysis: DocumentAnalysis): BoardBlock[] {
  const blocks: BoardBlock[] = [
    makeBoardBlock({
      zone: "middle",
      type: "heading",
      content: analysis.title || analysis.subject || "Cours",
    }),
  ];

  const points = (analysis.teaching_points ?? []).filter((point) => point.title);
  if (points.length) {
    // Compact roadmap: top-level sections only (never the full point enumeration).
    const sections = points.filter((point) => point.kind === "section");
    const roadmap = (sections.length >= 2 ? sections : points).slice(0, 6);
    blocks.push(
      makeBoardBlock({
        zone: "middle",
        type: "text",
        content: `خطة الدرس — ${points.length} نقطة، غنقراوهم كاملين واحد بواحد :`,
      }),
    );
    const items = roadmap.map((point) => `${point.title}${point.pages ? `  (p.${point.pages})` : ""}`);
    if (points.length > roadmap.length) items.push(`… +${points.length - roadmap.length} نقاط أخرى فالتفاصيل`);
    blocks.push(
      makeBoardBlock({
        zone: "middle",
        type: "objective",
        items,
      }),
    );
  } else if (analysis.objectives.length) {
    blocks.push(
      makeBoardBlock({
        zone: "middle",
        type: "objective",
        items: analysis.objectives.slice(0, 5),
      }),
    );
  }

  if (analysis.subject && analysis.title && analysis.subject !== analysis.title) {
    blocks.push(
      makeBoardBlock({
        zone: "middle",
        type: "text",
        content: `Matière : ${analysis.subject}${analysis.level && analysis.level !== "unknown" ? ` — Niveau : ${analysis.level}` : ""}`,
      }),
    );
  }

  return blocks;
}

/** Creates the yellow active-point heading the app seeds before PDF teaching begins. */
export function buildPointHeading(point: { title: string }): BoardBlock {
  return makeBoardBlock({ zone: "middle", type: "heading", content: point.title });
}

/** Right zone starts empty; examples are added only after the tutor speaks them. */
export function buildEmptyRightZone(): BoardBlock[] {
  return [];
}
