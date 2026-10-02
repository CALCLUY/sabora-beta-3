/**
 * Validates board-write payloads before they reach the visual board.
 * The large middle zone is an exam-style French / math surface: Darija prose
 * belongs in speech (or in an explicitly spoken right-zone example), never there.
 */
const ARABIC_SCRIPT = /[\u0600-\u06FF]/u;

/** Any backslash command: \\propto, \\text, \\frac… French prose never contains these. */
const LATEX_COMMAND = /\\[A-Za-z]{2,}/;

const MATH_COMMAND =
  /\\(frac|dfrac|sqrt|int|sum|prod|lim|vec|hat|overline|left|right|alpha|beta|gamma|delta|theta|lambda|mu|pi|rho|sigma|omega|Delta|Sigma|Omega|times|cdot|div|leq|geq|neq|approx|infty|partial|rightarrow|to|log|ln|sin|cos|tan)\b/;

export function hasArabicScript(value: unknown): boolean {
  if (typeof value === "string") return ARABIC_SCRIPT.test(value);
  if (Array.isArray(value)) return value.some((item) => hasArabicScript(item));
  return false;
}

/** Detects an equation/formula written as plain text (not normal French prose). */
export function looksLikeEquation(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text || ARABIC_SCRIPT.test(text)) return false;

  // If it has inline math delimiters $...$, it is prose with embedded math, not a standalone formula
  if (/\$/.test(text)) return false;

  // Inspect prose words outside \text{...}
  const withoutText = text.replace(/\\text(?:bf|it|rm|sf|tt)?\{[^}]*\}/g, "");
  const proseRegex = /\b(soit|soient|on|et|ou|avec|dans|pour|est|sont|si|donc|comme|qui|que|par|sur|une?|les?|des?|du|ce|cette|ces|son|sa|ses|leur|leurs|notre|votre|cette|droite|gauche|dépend|relation|complexe|nombre|forme)\b/i;
  if (proseRegex.test(withoutText)) return false;

  // A LaTeX control sequence without external prose words:
  if (LATEX_COMMAND.test(text)) return true;
  if (text.length > 120) return false;
  if (MATH_COMMAND.test(text)) return true;

  const words = text.split(/\s+/).filter(Boolean);
  const proseWords = words.filter((word) => /^[A-Za-zÀ-ÿ]{4,}[.,;:!?]?$/.test(word)).length;
  if (proseWords >= 3) return false;

  const hasRelation = /[=<>≤≥≠]/.test(text);
  const hasMathSyntax = /[\^_]|\\|\//.test(text);
  const hasSymbolAndDigit = /[A-Za-z]/.test(text) && /\d/.test(text);
  const hasFunctionCall = /[A-Za-z]\s*\(\s*[A-Za-z0-9]/.test(text);
  const hasShortOperands = /(^|[\s(])[A-Za-z0-9]{1,3}\s*[+*×÷]\s*[A-Za-z0-9]{1,3}([\s)]|$)/.test(text);
  return hasRelation || hasMathSyntax || hasSymbolAndDigit || hasFunctionCall || hasShortOperands;
}

/** True when the string is a Latin word (not math) before a "label :" split. */
function isPlainLabel(label: string): boolean {
  return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\- ]*$/.test(label) && !/[=<>≤≥≠^_\\\/]/.test(label);
}

/**
 * Makes model-written math explicit for tool feedback; rendering still has its own fallback.
 * "Label : equation" is left as text: the renderer keeps the label handwritten and
 * typesets only the equation, instead of math-fonding the whole line.
 * IMPORTANT: content that has $...$ delimiters is PROSE with inline math (e.g.
 * "Soit $z = a + ib$ et son conjugué $\bar{z} = a - ib$"). It must stay as text so
 * ChalkText can render the prose in French and only the $...$ spans as KaTeX inline.
 * Promoting it to type='formula' would strip the $ signs and pass the entire
 * French sentence to KaTeX display mode, which collapses all spaces and produces
 * "Soitz = a + ibetz̄ = a − ib" as a single unbroken formula.
 */
export function normalizeBoardWriteMath(args: Record<string, unknown>): Record<string, unknown> {
  const type = args.type;
  const zone = args.zone;
  if (zone !== "middle" || (type !== "text" && type !== "takeaway")) return args;
  const content = typeof args.content === "string" ? args.content.trim() : "";

  // $...$ delimiters = prose with inline math. ChalkText handles this correctly
  // via its inlineMath pipeline; promoting to formula would destroy the layout.
  if (/\$[^$\n]+\$/.test(content)) return args;

  // A pure LaTeX formula has NO $ signs and NO French prose words around the math.
  if (!looksLikeEquation(content)) return args;

  const split = content.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\- ]{1,30})\s*[:：]\s*([\s\S]+)$/);
  if (split && isPlainLabel(split[1]) && looksLikeEquation(split[2])) return args;

  return { ...args, type: type === "takeaway" ? "takeaway" : "formula" };
}

/**
 * A question posed to the learner becomes a dedicated question block: it is
 * labelled "Question :", never framed, and never wipes existing content.
 * Recognized from an explicit "Question :" prefix or a trailing question mark.
 */
export function normalizeBoardWriteQuestion(args: Record<string, unknown>): Record<string, unknown> {
  if (args.zone !== "middle" || args.items) return args;
  if (args.type !== "text" && args.type !== "question") return args;
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) return args;

  // The board adds "Question :" itself, so strip any label the model included.
  const labelled = content.match(/^(?:questions?|q\s*\d*)\s*[:：]\s*([\s\S]+)$/i);
  if (args.type === "question") {
    const body = (labelled ? labelled[1].trim() : content).replace(/\s*[:：]\s*$/, "");
    return body ? { ...args, content: body } : args;
  }

  const isQuestion = Boolean(labelled) || /[?؟]\s*$/.test(content);
  if (!isQuestion) return args;

  const body = (labelled ? labelled[1].trim() : content).replace(/\s*[:：]\s*$/, "");
  if (!body) return args;
  return { ...args, type: "question", content: body };
}

/** Longest board question accepted; board questions must stay short and simple. */
export const MAX_QUESTION_CHARS = 180;

/** Labels that are sentence openers, not defined terms — left as plain text. */
const NON_TERM_LABELS = new Set([
  "definition", "définition", "résultat", "resultat", "conclusion", "remarque",
  "formule", "exemple", "rappel", "programme", "plan", "note", "observation",
  "question", "questions", "q", "q1", "q2", "q3",
  "attention", "attentions", "garde", "gardez", "il faut", "il ne faut", "ne pas",
  "à retenir", "astuce", "erreur", "erreur fréquente",
]);

/**
 * "Term : French definition prose" written as plain text becomes a proper
 * definition block, so the term is yellow, boxed and framed instead of a
 * white paragraph with no hierarchy.
 */
export function normalizeBoardWriteDefinition(args: Record<string, unknown>): Record<string, unknown> {
  if (args.zone !== "middle" || args.type !== "text" || args.items) return args;
  const content = typeof args.content === "string" ? args.content.trim() : "";
  const match = content.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\- ]{1,40})\s*[:：]\s*([\s\S]+)$/);
  if (!match) return args;
  const label = match[1].trim().replace(/\s+/g, " ");
  const tail = match[2].trim();
  if (NON_TERM_LABELS.has(label.toLowerCase())) return args;
  if (looksLikeEquation(tail) || ARABIC_SCRIPT.test(tail)) return args;
  // Enumerations ("Programme : 1. ... 2. ...") are roadmaps, not definitions.
  if (/^\s*\d+[.)]\s/.test(tail)) return args;
  const tailWords = tail.split(/\s+/).filter((word) => /^[A-Za-zÀ-ÿ]{3,}/.test(word));
  if (tail.length < 25 || tailWords.length < 4) return args;
  return { ...args, type: "definition", term: label, content: tail };
}
