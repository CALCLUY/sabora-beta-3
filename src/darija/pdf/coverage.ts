/**
 * Lesson coverage: guarantees the tutor teaches the WHOLE PDF, not just a few points.
 */
import type { DocumentAnalysis, LoadedDocument } from "./analyze";

export type LessonPoint = {
  id: string;
  title: string;
  pages: string;
  kind: string;
  summary: string;
};

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Fallback checklist when analysis lacks an exhaustive teaching plan. */
function derivePoints(analysis: DocumentAnalysis | null, doc: LoadedDocument | null): LessonPoint[] {
  const points: LessonPoint[] = [];
  let counter = 1;
  const push = (title: string, pages: string, kind: string, summary: string) => {
    points.push({ id: `P${counter++}`, title, pages, kind, summary });
  };

  if (analysis) {
    for (const section of analysis.sections) {
      if (!section.title && !section.content) continue;
      push(section.title || `Section ${counter}`, section.pages, "section", clip(section.content || section.title, 280));
    }
    const seenTitles = new Set(points.map((point) => point.title.toLowerCase()));
    for (const concept of analysis.key_concepts) {
      if (!concept.term || seenTitles.has(concept.term.toLowerCase())) continue;
      seenTitles.add(concept.term.toLowerCase());
      push(concept.term, "", "definition", clip(concept.explanation || concept.term, 200));
    }
    for (const formula of analysis.formulas.slice(0, 10)) push(`Formule : ${clip(formula, 60)}`, "", "formula", formula);
    for (const exercise of analysis.exercises) {
      push(exercise.id, exercise.page, "exercise", clip(exercise.statement || exercise.parts.join(" / "), 220));
    }
  }

  // Text-only PDFs (no analysis): one point per page group so the whole file is covered.
  if (!points.length && doc?.extracted) {
    const pages = doc.extracted.pages.filter((page) => page.text.trim());
    const GROUP = 3;
    for (let start = 0; start < pages.length; start += GROUP) {
      const group = pages.slice(start, start + GROUP);
      const first = group[0].page;
      const last = group[group.length - 1].page;
      push(
        group.length > 1 ? `Pages ${first}-${last}` : `Page ${first}`,
        group.length > 1 ? `${first}-${last}` : `${first}`,
        "section",
        clip(group.map((page) => page.text).join(" ").slice(0, 400), 280),
      );
      if (points.length >= 20) break;
    }
  }
  return points;
}

export function getLessonPoints(doc: LoadedDocument | null): LessonPoint[] {
  if (!doc) return [];
  const source = (doc.analysis?.teaching_points ?? []).filter((point) => point.title);
  if (source.length) {
    return source.map((point, index) => ({
      id: point.id || `P${index + 1}`,
      title: point.title,
      pages: point.pages,
      kind: point.kind || "section",
      summary: point.summary,
    }));
  }
  return derivePoints(doc.analysis, doc);
}

export function nextUncoveredPoint(points: LessonPoint[], coveredIds: readonly string[]): LessonPoint | null {
  const covered = new Set(coveredIds);
  return points.find((point) => !covered.has(point.id)) ?? null;
}

/** Per-turn block names the exact point, but explicitly forbids reading point IDs/counts aloud. */
export function buildCoverageContext(
  points: LessonPoint[],
  coveredIds: readonly string[],
  currentId: string | null,
): string {
  if (!points.length) return "";
  const covered = new Set(coveredIds);
  const current = points.find((point) => point.id === currentId && !covered.has(point.id))
    ?? nextUncoveredPoint(points, coveredIds);

  const lines = ["[VOX-COVERAGE]", `Progress is internal UI metadata only: ${covered.size}/${points.length}. NEVER say these numbers or IDs aloud.`];
  if (!current) {
    lines.push("ALL POINTS ARE COVERED. Give the final wrapup (recap + 2 review cues). Do not invent new content.");
    lines.push("[/VOX-COVERAGE]");
    return lines.join("\n");
  }
  lines.push(`CURRENT POINT: ${current.id} — ${current.title}${current.pages ? ` (p.${current.pages})` : ""} [${current.kind}]`);
  if (current.summary) lines.push(`Content: ${clip(current.summary, 600)}`);
  lines.push("Teach ONLY this point this turn. Do NOT announce its number, ID, or how many points remain. Say its topic/page naturally. Give its exact French reference on the board, explain it in Darija, then ask ONE simple check question and stop. Do not teach the next point until the learner answers and you give feedback.");
  const upcoming = points.filter((point) => !covered.has(point.id) && point.id !== current.id);
  if (upcoming.length) lines.push(`Still to come (internal only; NEVER read this list aloud): ${upcoming.map((point) => `${point.id} ${point.title}`).join(" · ")}`);
  else lines.push("This is the last uncovered point. After the learner answers its check question and receives feedback, give a final wrapup.");
  if (covered.size) lines.push(`Already taught (internal only; do not repeat): ${points.filter((point) => covered.has(point.id)).map((point) => point.id).join(", ")}.`);
  lines.push("Organize the board: heading → definition → numbered steps → key formula with proactive arrows/circles → takeaway. Keep this hierarchy for every PDF point.");
  lines.push("[/VOX-COVERAGE]");
  return lines.join("\n");
}

/**
 * Post-check context: the point remains current until the learner answers and
 * Vox gives feedback. This prevents auto-advancing/restarting the PDF at the top.
 */
export function buildCoverageAnswerContext(point: LessonPoint): string {
  return `[VOX-COVERAGE-ANSWER]\nCURRENT PDF POINT (still in progress): ${point.title}${point.pages ? ` (p.${point.pages})` : ""}. Vox has already taught this point and asked its check question. The student has now replied. First respond directly to THEIR reply: if correct, say why briefly; if wrong, identify the one misconception and give one specific retry step; if unrelated, answer the clarification and keep the point pending. Do NOT re-introduce the PDF, summarize its title/sections, restart the explanation from the beginning, or teach the next point in this feedback turn. If (and only if) their check answer is correct or their supported retry shows the point is covered, call lesson_point_complete(pointId="${point.id}") AFTER the brief feedback. If they remain confused or you ask them to retry, DO NOT call lesson_point_complete — keep this same point current. NEVER say the point ID, its number, or the number of points remaining. Stop after this one feedback action.\n[/VOX-COVERAGE-ANSWER]`;
}
