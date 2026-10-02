"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { Check, Copy, Download, Eraser, Expand, Maximize2, Minimize2, Presentation, Shrink } from "lucide-react";
import { AnnotationLayer } from "./AnnotationLayer";
import { ConnectorLayer } from "./ConnectorLayer";
import { assignConnectorSides, connectorGutters } from "./connect";
import { boardToNotes } from "./notes";
import { sanitizeSvgMarkup } from "./sanitizeSvg";
import type { BoardAnnotation, BoardBlock, BoardConnector, BoardZone } from "./types";

function highlightFormulaSymbols(source: string, symbols: string[] = []): string {
  let result = source.trim().replace(/^\\?\[|\\?\]$/g, "").replace(/[\$]/g, "");
  for (const symbol of symbols) {
    if (/^[A-Za-z]$/.test(symbol)) {
      const safe = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(`(?<![A-Za-z\\\\])${safe}(?![A-Za-z])`, "g"), `\\textcolor{red}{${symbol}}`);
    } else if (/^(?:alpha|beta|gamma|delta|theta|lambda|mu|rho|sigma|omega|Delta|Sigma|Omega)$/.test(symbol)) {
      const command = `\\${symbol}`;
      const commandPattern = new RegExp(String.raw`\\${symbol}(?![A-Za-z])`, "g");
      result = result.replace(commandPattern, `\\textcolor{red}{${command}}`);
    }
  }
  return result;
}

function renderLatexSafe(source: string, accentSymbols: string[] = []): string | null {
  try {
    const clean = highlightFormulaSymbols(source, accentSymbols).replace(/[\$]/g, "").trim();
    const html = katex.renderToString(clean, { throwOnError: false, displayMode: true, strict: "ignore" });
    // If KaTeX encountered an error, return null so it falls back to rich prose rendering
    if (html.includes("class=\"katex-error\"")) {
      return null;
    }
    return html;
  } catch {
    return null;
  }
}

function renderLatexInlineSafe(source: string): string | null {
  try {
    const clean = source.trim().replace(/[\$]/g, "");
    const html = katex.renderToString(clean, { throwOnError: false, displayMode: false, strict: "ignore" });
    if (html.includes("class=\"katex-error\"")) {
      return null;
    }
    return html;
  } catch {
    return null;
  }
}

function renderChalkText(raw: string): ReactNode {
  if (!raw) return null;

  if (/^\\(frac|sqrt|int|sum|alpha|beta|theta|Delta|times|vec|begin)/.test(raw.trim()) && !/[\u0600-\u06FF]/.test(raw)) {
    const display = renderLatexSafe(raw);
    if (display) {
      return <div className="board-latex" dir="ltr" dangerouslySetInnerHTML={{ __html: display }} />;
    }
  }

  const mathChunks = raw.split(/(\$[^$\n]+\$)/g);

  return (
    <>
      {mathChunks.map((chunk, chunkIdx) => {
        if (chunk.startsWith("$") && chunk.endsWith("$") && chunk.length > 2) {
          const math = chunk.slice(1, -1);
          const inlineHtml = renderLatexInlineSafe(math);
          if (inlineHtml) {
            return (
              <span
                key={chunkIdx}
                className="board-latex-inline"
                dir="ltr"
                dangerouslySetInnerHTML={{ __html: inlineHtml }}
              />
            );
          }
          return (
            <span key={chunkIdx} className="board-latin font-chalk-hand" dir="ltr">
              {math}
            </span>
          );
        }

        const parts = chunk.split(/([\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+)/gu);
        return (
          <span key={chunkIdx}>
            {parts.map((segment, segIdx) => {
              if (/[\u0600-\u06FF]/.test(segment)) {
                return (
                  <span key={segIdx} className="board-arabic">
                    {segment}
                  </span>
                );
              }
              if (/[a-zA-Z]/.test(segment)) {
                // No dir="ltr" here: a dir attribute isolates each word, and inside an
                // RTL (Darija) line isolated words get laid out right-to-left, flipping
                // "la partie réelle" into "réelle partie la". Without isolation the
                // Unicode bidi algorithm keeps consecutive French words as one LTR run.
                return (
                  <span key={segIdx} className="board-latin">
                    {segment}
                  </span>
                );
              }
              return segment;
            })}
          </span>
        );
      })}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Speech-paced, line-by-line handwriting                                     */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Math detection                                                             */
/*                                                                            */
/* The model often writes an equation into a takeaway/text block instead of a  */
/* formula block (e.g. a red final answer "(c)' = 0"). Those must still be     */
/* typeset with KaTeX rather than shown as raw characters.                     */
/* -------------------------------------------------------------------------- */

const MATH_COMMAND =
  /\\(frac|dfrac|sqrt|int|sum|prod|lim|vec|hat|overline|left|right|alpha|beta|gamma|delta|theta|lambda|mu|pi|rho|sigma|omega|Delta|Sigma|Omega|times|cdot|div|leq|geq|neq|approx|infty|partial|rightarrow|to|log|ln|sin|cos|tan)\b/;

/** Any backslash command (\propto, \text, \frac…): proof the string is LaTeX source. */
const LATEX_COMMAND = /\\[A-Za-z]{2,}/;

/** True when a Latin-script string is LaTeX source or reads as an equation. */
function looksLikeMath(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (/[\u0600-\u06FF]/.test(text)) return false; // Darija prose

  // If the text contains inline math delimiters $...$, it is PROSE with embedded math,
  // NOT a pure standalone display formula!
  if (/\$/.test(text)) return false;

  // Inspect words outside \text{...}
  const withoutText = text.replace(/\\text(?:bf|it|rm|sf|tt)?\{[^}]*\}/g, "");
  const proseRegex = /\b(soit|soient|on|et|ou|avec|dans|pour|est|sont|si|donc|comme|qui|que|par|sur|une?|les?|des?|du|ce|cette|ces|son|sa|ses|leur|leurs|notre|votre|cette|droite|gauche|dépend|relation|complexe|nombre|forme)\b/i;
  if (proseRegex.test(withoutText)) return false;

  // A control sequence settles it:
  if (LATEX_COMMAND.test(text)) return true;
  if (text.length > 90) return false;
  if (MATH_COMMAND.test(text)) return true;

  // Prose guard: several ordinary words means it is a sentence, not an equation.
  const words = text.split(/\s+/).filter(Boolean);
  const proseWords = words.filter((word) => /^[A-Za-zÀ-ÿ]{4,}[.,;:!?]?$/.test(word)).length;
  if (proseWords >= 3) return false;

  const hasRelation = /[=<>≤≥≠]/.test(text);
  const hasMathSyntax = /[\^_]|\\|\//.test(text);
  const hasSymbolAndDigit = /[A-Za-z]/.test(text) && /\d/.test(text);
  // Function application such as f(x), and short operand arithmetic like a + b.
  const hasFunctionCall = /[A-Za-z]\s*\(\s*[A-Za-z0-9]/.test(text);
  const hasShortOperands = /(^|[\s(])[A-Za-z0-9]{1,3}\s*[+*×÷]\s*[A-Za-z0-9]{1,3}([\s)]|$)/.test(text);
  return hasRelation || hasMathSyntax || hasSymbolAndDigit || hasFunctionCall || hasShortOperands;
}

/**
 * Splits "Label : equation" so the label stays handwritten prose and only the
 * equation is typeset. Returns null when the whole string is (or isn't) math.
 */
function splitLabelledMath(raw: string): { label: string; math: string } | null {
  const match = raw.trim().match(/^([^:：]{2,40}[:：])\s*([\s\S]+)$/);
  if (!match) return null;
  const [, label, tail] = match;
  if (!looksLikeMath(tail)) return null;
  return { label: label.trim(), math: tail.trim() };
}

function isMostlyArabic(text: string): boolean {
  const arabic = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > latin;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

/** Rough total writing time, used only to sequence one block after another. */
function estimateWriteSeconds(text: string, rtl: boolean): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.min(4.5, Math.max(0.45, (text.length * (rtl ? 0.07 : 0.055)) / 1.35)) + words.length * 0.02;
}

/* -------------------------------------------------------------------------- */
/* Real visual line measurement                                               */
/*                                                                            */
/* The text is laid out invisibly with the exact same styles, then each word's */
/* vertical position is read from the DOM. The lines the teacher writes are    */
/* therefore the browser's own wrapped lines, so the layout while writing is   */
/* identical to the layout once finished — nothing reflows at the end.         */
/* -------------------------------------------------------------------------- */

type Token = { kind: "word" | "br"; text: string };

function autoCloseDollars(str: string): string {
  const count = (str.match(/\$/g) || []).length;
  if (count % 2 === 1) {
    return str + "$";
  }
  return str;
}

/** Words are atomic; an inline $...$ formula stays on one line; \n forces a break. */
function tokenizeText(text: string): Token[] {
  const tokens: Token[] = [];
  const balanced = autoCloseDollars(text);
  balanced.split(/(\n+)/).forEach((part, index) => {
    if (index > 0) tokens.push({ kind: "br", text: "" });
    for (const word of part.match(/\$[^$]+\$|\S+/g) ?? []) {
      tokens.push({ kind: "word", text: word });
    }
  });
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* Inline math inside prose                                                    */
/*                                                                            */
/* Consecutive tokens that look like an equation ("i^2 = -1", "Ec = 1/2 m     */
/* v^2") are grouped into one math unit and typeset with KaTeX, so definitions */
/* and text blocks show real math even when the model skipped $...$ markup.    */
/* -------------------------------------------------------------------------- */

/** `suffix` = sentence punctuation that followed a math run, drawn tight after it. */
type Unit = { kind: "word" | "math"; text: string; suffix?: string };
type FlatUnit = { kind: "br" } | Unit;

/** Symbols that never occur inside ordinary French words. */
const STRONG_MATH = /[=<>≤≥≠^_±×÷*/\\{}|√∫∑∏π∞→≈]/;
/** A token made only of operators ("=", "+", "-", "≤"…). */
const OPERATOR_TOKEN = /^[=<>≤≥≠+\-−×÷*/·±]+$/;
/**
 * A LaTeX control sequence ("\\bar", "\\;", "\\frac") possibly with trailing
 * braces/punct, e.g. "\\bar{z}" or "\\;". These must NEVER start or split a math
 * run on their own — a lone "\\" typesets to nothing and the rest of the line
 * falls out of the formula.
 */
const LATEX_COMMAND_TOKEN = /^\\(?:[A-Za-z]+\*?|[{}[,\];!?|])/;

/** "et/ou" and similar word/word slashes are prose, not math (d/t, 1/2 stay math). */
function isWordSlashWord(token: string): boolean {
  return /^[A-Za-zÀ-ÿ]{2,}(?:\/[A-Za-zÀ-ÿ]{2,})+$/.test(token);
}

function isFunctionCall(token: string): boolean {
  return /\([A-Za-z0-9.]+\)/.test(token);
}

/** Splits trailing sentence punctuation off a token: "ib," -> { core: "ib", punct: "," }. */
function splitPunct(token: string): { core: string; punct: string } {
  const match = token.match(/^(.*?)([.,;:!?]+)$/);
  return match && match[1] ? { core: match[1], punct: match[2] } : { core: token, punct: "" };
}

function hasStrongMath(core: string): boolean {
  return (STRONG_MATH.test(core) && !isWordSlashWord(core)) || isFunctionCall(core);
}

const isNumber = (core: string) => /^[-−]?\d+(?:[.,]\d+)?$/.test(core);
/** Short identifiers such as z, ib, dx, Ec (only trusted right after an operator). */
const isShortIdentifier = (core: string) => /^[A-Za-z]{1,3}$/.test(core);
/** 2i, 3x, -4ab, x2 */
const isNumberIdentifier = (core: string) =>
  /^[-−]?\d+(?:[.,]\d+)?[A-Za-z]{1,3}$/.test(core) || /^[A-Za-z]\d+$/.test(core);

/** Tokens that may sit on the left of an equation ("z" in "z = a + ib"). */
function isLeftOperand(token: string): boolean {
  const { core, punct } = splitPunct(token);
  if (punct) return false;
  return isShortIdentifier(core) || isNumber(core) || isNumberIdentifier(core) || hasStrongMath(core);
}

/**
 * Groups $...$ marks and equation-looking runs into math units; the rest are words.
 *
 * Runs follow math grammar rather than a loose symbol match, so a whole equation
 * becomes ONE KaTeX unit (uniform font and baseline) instead of alternating
 * handwritten/typeset fragments:
 *  - a run starts on a token with a strong math symbol (i^2, =, f(x), 1/2), or on a
 *    pure operator (+, -) flanked by an operand;
 *  - it backtracks one token to include the equation's left side ("z" before "=");
 *  - 2-3 letter operands (ib, dx) are only accepted right after an operator, so
 *    French words (de, la, et, où, est) never get swallowed;
 *  - implicit products ("1/2 m v^2") are accepted only when math continues after;
 *  - sentence punctuation ends the run and is kept as a tight suffix.
 */
function toUnits(words: string[], detectRuns: boolean): Unit[] {
  const units: Unit[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w.startsWith("$") && w.endsWith("$") && w.length > 2) {
      units.push({ kind: "math", text: w.slice(1, -1) });
      i += 1;
      continue;
    }

    // Test the RAW token for a LaTeX command first: splitPunct would strip the ";"
    // off "\;" and leave a lone backslash, which typesets to nothing.
    const isLatexStart = LATEX_COMMAND_TOKEN.test(w);
    const { core: startCore, punct: startPunct } = splitPunct(w);
    const nextCore = i + 1 < words.length ? splitPunct(words[i + 1]).core : "";
    const prev = units[units.length - 1];
    const prevIsOperand = Boolean(prev && prev.kind === "word" && isLeftOperand(prev.text));
    const startsRun =
      detectRuns &&
      (isLatexStart ||
        hasStrongMath(startCore) ||
        (OPERATOR_TOKEN.test(startCore) &&
          (prevIsOperand || isNumber(nextCore) || isShortIdentifier(nextCore) || hasStrongMath(nextCore))));

    if (!startsRun) {
      units.push({ kind: "word", text: w });
      i += 1;
      continue;
    }

    const span: string[] = [];
    // Left side of the equation: "z" in "z = a + ib", "Ec" in "Ec = 1/2 m v^2".
    const backtracked = /^[=<>≤≥≠+\-−×÷*/·±]/.test(startCore) && prevIsOperand;
    if (backtracked) {
      span.push(prev.text);
      units.pop();
    }
    // Keep the raw token for LaTeX commands ("\;", "\bar{z}") so KaTeX sees them whole.
    span.push(isLatexStart ? w : startCore);

    // For a LaTeX command the trailing chars belong to the command itself
    // ("\;" is spacing), not sentence punctuation — so the run must continue.
    let suffix = isLatexStart ? "" : startPunct;
    let afterOperator = OPERATOR_TOKEN.test(startCore) || LATEX_COMMAND_TOKEN.test(startCore);
    let j = i + 1;
    while (!suffix && j < words.length) {
      const { core, punct } = splitPunct(words[j]);
      let accept = false;
      if (LATEX_COMMAND_TOKEN.test(words[j]) || LATEX_COMMAND_TOKEN.test(core)) {
        // A LaTeX command (\;, \bar{z}, \frac{a}{b}) always continues the run:
        // splitting on it produced a lone backslash that typeset to nothing.
        accept = true;
      } else if (OPERATOR_TOKEN.test(core) || hasStrongMath(core) || isNumberIdentifier(core)) {
        accept = true;
      } else if (afterOperator && (isNumber(core) || isShortIdentifier(core) || /^[([{]/.test(core))) {
        accept = true; // operand/group right after an operator: "+ ib", "= -1", "(a+ib)"
      } else if (!afterOperator && (isNumber(core) || /^[A-Za-z]$/.test(core) || isNumberIdentifier(core))) {
        // Implicit product ("1/2 m v^2") only when the math keeps going.
        const following = j + 1 < words.length ? splitPunct(words[j + 1]).core : "";
        accept = !punct && (OPERATOR_TOKEN.test(following) || hasStrongMath(following) || isNumberIdentifier(following));
      }
      if (!accept) break;
      // Push the RAW token so "\;" keeps its semicolon (KaTeX needs it).
      span.push(words[j]);
      afterOperator = LATEX_COMMAND_TOKEN.test(words[j]) || OPERATOR_TOKEN.test(core);
      // Punctuation after a LaTeX command is not the end of the formula.
      suffix = LATEX_COMMAND_TOKEN.test(words[j]) ? "" : punct;
      j += 1;
    }

    // Trailing operators are dangling (a French dash: "ou pas - existe"): trim them
    // off; they are re-emitted as plain words below. Never trim a LaTeX command.
    let end = span.length;
    while (end > 0 && OPERATOR_TOKEN.test(span[end - 1])) end -= 1;
    const trimmed = span.length - end;
    const mathTokens = span.slice(0, end);
    const isRealMath =
      mathTokens.some((token) => LATEX_COMMAND_TOKEN.test(token) || hasStrongMath(token)) ||
      (mathTokens.length >= 2 && mathTokens.some((token) => OPERATOR_TOKEN.test(token)));
    void isLatexStart;

    if (!isRealMath) {
      // Not an equation after all: restore everything as prose.
      if (backtracked && prev) units.push(prev);
      for (let k = i; k < j; k += 1) units.push({ kind: "word", text: words[k] });
      i = j;
      continue;
    }

    units.push({ kind: "math", text: mathTokens.join(" "), suffix: trimmed ? undefined : suffix || undefined });
    for (let k = j - trimmed; k < j; k += 1) units.push({ kind: "word", text: words[k] });
    i = j;
  }
  return units;
}

function toFlatUnits(tokens: Array<Token>, detectRuns: boolean): FlatUnit[] {
  const out: FlatUnit[] = [];
  let segment: string[] = [];
  const flush = () => {
    if (segment.length) out.push(...toUnits(segment, detectRuns));
    segment = [];
  };
  for (const token of tokens) {
    if (token.kind === "br") {
      flush();
      out.push({ kind: "br" });
    } else {
      segment.push(token.text);
    }
  }
  flush();
  return out;
}

function MathInline({ text }: { text: string }) {
  const html = useMemo(() => {
    try {
      const clean = text.replace(/[\$]/g, "").trim();
      const rendered = katex.renderToString(clean, { throwOnError: false, displayMode: false, strict: "ignore" });
      if (rendered.includes("class=\"katex-error\"")) {
        // Strip the KaTeX dark-red error color so it renders as normal chalk color
        return rendered.replace(/style="color:#cc0000"/g, 'style="color:inherit"');
      }
      return rendered;
    } catch {
      return null;
    }
  }, [text]);
  if (!html) return <>{text.replace(/[\$]/g, "")}</>;
  return <span className="board-latex-inline" dir="ltr" dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderUnit(unit: Unit, key: number | string): ReactNode {
  return unit.kind === "math" ? (
    <span key={key}>
      <MathInline text={unit.text} />
      {unit.suffix ?? ""}{" "}
    </span>
  ) : (
    <span key={key}>{renderChalkText(unit.text)}{" "}</span>
  );
}

function renderUnits(units: Unit[]): ReactNode {
  return units.map((unit, index) => renderUnit(unit, index));
}

type VisualLine = { units: Unit[]; br: boolean };

function useVisualLines(flat: FlatUnit[]) {
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [lines, setLines] = useState<VisualLine[] | null>(null);

  useEffect(() => {
    const host = measureRef.current;
    if (!host) return;
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;
      const nodes = Array.from(host.querySelectorAll<HTMLElement>("[data-unit],[data-br]"));
      if (!nodes.length) {
        setLines([]);
        return;
      }
      const result: VisualLine[] = [];
      let current: Unit[] = [];
      let currentTop: number | null = null;
      for (const node of nodes) {
        if (node.dataset.br === "1") {
          if (current.length) {
            result.push({ units: current, br: false });
            current = [];
          }
          result.push({ units: [], br: true });
          currentTop = null;
          continue;
        }
        const unitText = node.dataset.unit ?? "";
        const isMath = node.dataset.math === "1";
        const unitSuffix = node.dataset.suffix || undefined;
        const top = node.getBoundingClientRect().top;
        if (currentTop === null || Math.abs(top - currentTop) <= 3) {
          current.push({ kind: isMath ? "math" : "word", text: unitText, suffix: unitSuffix });
          if (currentTop === null) currentTop = top;
        } else {
          result.push({ units: current, br: false });
          current = [{ kind: isMath ? "math" : "word", text: unitText, suffix: unitSuffix }];
          currentTop = top;
        }
      }
      if (current.length) result.push({ units: current, br: false });
      setLines(result);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    // Re-measure once the handwritten webfonts have actually loaded.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          if (!cancelled) measure();
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [flat]);

  return { measureRef, lines };
}

function lineDurationSec(line: string, index: number, seed: number, rtl: boolean): number {
  // Natural chalk is slower than a typewriter: Latin/French usually has more
  // connected cursive strokes, while Arabic has longer joined strokes. Punctuation
  // creates a small real-hand pause at the end of a line.
  const chars = line.replace(/\s+/g, "").length;
  const words = line.trim().split(/\s+/).filter(Boolean).length;
  const base = chars * (rtl ? 0.078 : 0.066) + words * 0.018;
  const punctuationPause = /[.!?؟؛:：]$/.test(line.trim()) ? 0.11 : /[,،]$/.test(line.trim()) ? 0.055 : 0;
  const raw = Math.sin(seed * 127.1 + index * 311.7) * 43758.5453;
  const jitter = 0.9 + (raw - Math.floor(raw)) * 0.2; // stable ±10% human variance
  return Math.min(3.1, Math.max(0.52, base * jitter + punctuationPause));
}

/**
 * Writes (or displays) text line by line, where the lines are the real wrapped
 * lines of the finished layout. `animate={false}` renders the very same lines
 * statically, so writing and finished states share one layout.
 */
function ChalkText({
  text,
  className,
  dir,
  animate,
  startDelay = 0,
  inlineMath = false,
  onDone,
}: {
  text: string;
  className?: string;
  dir?: "ltr" | "rtl";
  animate: boolean;
  startDelay?: number;
  /** Typeset equation-looking runs (i^2 = -1) with KaTeX inside prose. */
  inlineMath?: boolean;
  onDone?: () => void;
}) {
  const flat = useMemo(() => toFlatUnits(tokenizeText(text), inlineMath), [text, inlineMath]);
  const { measureRef, lines } = useVisualLines(flat);
  const rtl = dir ? dir === "rtl" : isMostlyArabic(text);

  const plan = useMemo(() => {
    if (!lines) {
      return [] as Array<{
        line: VisualLine;
        delay: number;
        duration: number;
      }>;
    }
    const seed = hashString(text);
    // A short natural lead-in before the line writing begins.
    let delay = Math.max(0.12, startDelay);
    return lines.map((line, index) => {
      const content = line.units.map((unit) => unit.text).join(" ");
      const duration = line.br ? 0 : lineDurationSec(content || " ", index, seed, rtl);
      const entry = { line, delay, duration };
      delay += duration + (line.br ? 0.035 : 0.1);
      return entry;
    });
  }, [lines, startDelay, rtl, text]);

  const total = plan.length ? plan[plan.length - 1].delay + plan[plan.length - 1].duration : 0;

  useEffect(() => {
    if (!onDone || !lines) return;
    const timer = setTimeout(onDone, total * 1000 + 90);
    return () => clearTimeout(timer);
  }, [onDone, total, lines]);

  return (
    <div className={`${className ?? ""} chalk-host`} dir={rtl ? "rtl" : "ltr"}>
      {/* Same units (words AND KaTeX math) so the measured breaks match the rendered text. */}
      <div ref={measureRef} className={`chalk-measure ${className ?? ""}`} aria-hidden="true">
        {flat.map((unit, index) =>
          unit.kind === "br" ? (
            <br key={index} data-br="1" />
          ) : (
            <span
              key={index}
              data-unit={unit.text}
              data-math={unit.kind === "math" ? "1" : undefined}
              data-suffix={unit.kind === "math" ? unit.suffix : undefined}
            >
              {unit.kind === "math" ? (
                <>
                  <MathInline text={unit.text} />
                  {unit.suffix ?? ""}
                </>
              ) : (
                renderChalkText(unit.text)
              )}{" "}
            </span>
          ),
        )}
      </div>
      {lines === null ? (
        <div className="chalk-static">
          {flat.map((unit, index) =>
            unit.kind === "br" ? <br key={index} /> : renderUnit(unit, index),
          )}
        </div>
      ) : (
        plan.map(({ line, delay, duration }, index) =>
          line.br ? (
            <span key={index} className="chalk-line-break" />
          ) : (
            <span
              key={index}
              className={`chalk-hand-line ${rtl ? "is-rtl" : "is-ltr"}${animate ? "" : " is-static"}`}
              style={
                animate
                  ? ({
                      animationDelay: `${delay.toFixed(2)}s`,
                      animationDuration: `${duration.toFixed(2)}s`,
                    } as CSSProperties)
                  : undefined
              }
            >
              {renderUnits(line.units)}
            </span>
          ),
        )
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Chalk frame that draws itself snugly around a boxed block                   */
/* -------------------------------------------------------------------------- */

function ChalkFrame({ color }: { color: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const duration = useMemo(() => {
    if (!size) return 0.85;
    const perimeter = 2 * (size.w + size.h);
    return Math.min(1.5, Math.max(0.55, perimeter / 700));
  }, [size]);

  return (
    <div ref={ref} className="chalk-frame" aria-hidden="true" style={{ color }}>
      {size ? (
        <svg className="chalk-frame-svg" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
          <rect
            x={2.5}
            y={2.5}
            width={Math.max(0, size.w - 5)}
            height={Math.max(0, size.h - 5)}
            rx={10}
            pathLength={1}
            className="chalk-frame-stroke"
            style={{ animationDelay: "0.08s", animationDuration: `${duration.toFixed(2)}s` }}
          />
        </svg>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Block rendering                                                             */
/* -------------------------------------------------------------------------- */

const NO_ANNOTATIONS: BoardAnnotation[] = [];

const CHALK_COLORS: Record<string, string> = {
  white: "#fdf7e6",
  yellow: "#ffe066",
  red: "#ff5b61",
  blue: "#7ec8ff",
};

function BoardBlockView({
  block,
  blockIndex = 0,
  active = false,
  onWritten,
}: {
  block: BoardBlock;
  /** Position in the zone; used to stagger the erase wipe. */
  blockIndex?: number;
  /** True while this block is the one currently being written. */
  active?: boolean;
  onWritten?: (id: string) => void;
}) {
  const [hasFinishedWriting, setHasFinishedWriting] = useState(!active);
  const isWriting = active && !hasFinishedWriting;
  const finishWriting = useMemo(
    () => () => {
      setHasFinishedWriting(true);
      onWritten?.(block.id);
    },
    [onWritten, block.id],
  );

  // Plain text/takeaway blocks may still contain an equation the model wrote
  // without using a formula block; detect it so it is typeset, not shown raw.
  const isPlainTextual = block.type === "text" || block.type === "takeaway";

  // A "Label : equation" split wins, so the label never gets typeset as math.
  const labelledMath = useMemo(() => {
    if (!isPlainTextual) return null;
    const parts = splitLabelledMath(block.content);
    if (!parts) return null;
    const html = renderLatexSafe(parts.math, block.accentSymbols);
    return html ? { label: parts.label, html } : null;
  }, [isPlainTextual, block.content, block.accentSymbols]);

  const wholeIsMath = isPlainTextual && !labelledMath && looksLikeMath(block.content);
  const mathHtml = wholeIsMath ? renderLatexSafe(block.content, block.accentSymbols) : null;

  const rendersMath = Boolean(mathHtml) || Boolean(labelledMath);

  // Hand-drawn annotations: reserve a band above / below the block for the arrows
  // and labels (in em, so it scales with the board like all the chalk).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const annotations = block.annotations ?? NO_ANNOTATIONS;
  const aboveCount = annotations.filter((item) => item.side === "above").length;
  const belowCount = annotations.filter((item) => item.side === "below").length;
  const rootStyle = {
    "--wipe-index": blockIndex,
    // Every arrow has the same arm length, so one band per used side is enough.
    ...(aboveCount ? { marginTop: "2.7em" } : {}),
    ...(belowCount ? { marginBottom: "2.7em" } : {}),
  } as CSSProperties;

  const classes = [
    "board-block",
    `board-block-${block.type}`,
    `chalk-${block.color}`,
    block.boxed ? "board-block-boxed" : "",
    // Underlining typeset math looks wrong; the chalk frame already marks it.
    block.underline && !rendersMath ? "board-block-underline" : "",
    block.large ? "board-block-large" : "",
    annotations.length ? "has-annotations" : "",
  ]
    .filter(Boolean)
    .join(" ");

  let body: ReactNode;
  if (block.type === "example") {
    // The model sometimes sends title="Exemple de nombre complexe", which produced
    // "Exemple de Exemple de …". Strip any leading label and trailing colon.
    const title = block.title
      ?.trim()
      .replace(/^(?:exemples?|examples?|ex\.?)(?=[\s:'’]|$)\s*(?:de\s+|d['’]\s*|:\s*)?/i, "")
      .replace(/\s*[:：]\s*$/, "")
      .trim();
    const heading = title ? `Exemple de ${title} :` : "Exemple :";
    const bodyText = block.items?.length ? block.items.join("\n") : block.content;
    // The darija body starts once the spoken "Exemple de … :" label has been written.
    const headingDelay = estimateWriteSeconds(heading, false) + 0.12;
    body = (
      <div className="board-example">
        <ChalkText text={heading} className="board-example-title" dir="ltr" animate={isWriting} />
        <ChalkText
          text={bodyText}
          className="board-text board-example-body"
          dir="rtl"
          animate={isWriting}
          startDelay={isWriting ? headingDelay : 0}
          inlineMath
          onDone={isWriting ? finishWriting : undefined}
        />
      </div>
    );
  } else if (block.type === "question") {
    // A question posed to the learner: labelled, never framed, and never one that
    // wipes existing content (see applyBoardWrite). Written while being asked.
    body = (
      <div className="board-question">
        <ChalkText text="Question :" className="board-question-label" dir="ltr" animate={isWriting} />
        <ChalkText
          text={block.content}
          className="board-text board-question-text"
          animate={isWriting}
          inlineMath
          startDelay={isWriting ? 0.35 : 0}
          onDone={isWriting ? finishWriting : undefined}
        />
      </div>
    );
  } else if (block.type === "heading") {
    body = (
      <ChalkText
        text={block.content}
        className="board-heading chalk-title-text"
        dir="ltr"
        animate={isWriting}
        onDone={isWriting ? finishWriting : undefined}
      />
    );
  } else if (block.type === "definition") {
    const term = block.term?.trim() ?? "";
    const termDelay = term ? estimateWriteSeconds(`${term} :`, false) + 0.12 : 0.05;
    body = (
      <div className="board-definition">
        {term ? (
          <ChalkText text={`${term} :`} className="board-definition-term chalk-key-term" dir="ltr" animate={isWriting} />
        ) : null}
        <ChalkText
          text={block.content}
          className="board-text board-definition-copy"
          dir="ltr"
          animate={isWriting}
          startDelay={isWriting && term ? termDelay : 0}
          inlineMath
          onDone={isWriting ? finishWriting : undefined}
        />
      </div>
    );
  } else if (block.type === "objective" || block.type === "list") {
    const items = block.items?.length ? block.items : block.content ? [block.content] : [];
    const isRtlList = isMostlyArabic(items.join(" "));
    body = (
      <div className="board-list">
        {(() => {
          let acc = 0;
          return items.map((item, index) => {
            const delay = isWriting ? acc : 0;
            acc += estimateWriteSeconds(`• ${item}`, isRtlList) + 0.14;
            return (
              <ChalkText
                key={`${block.id}-li-${index}`}
                text={`• ${item}`}
                dir={isRtlList ? "rtl" : "ltr"}
                animate={isWriting}
                startDelay={delay}
                inlineMath
                onDone={isWriting && index === items.length - 1 ? finishWriting : undefined}
              />
            );
          });
        })()}
      </div>
    );
  } else if (block.type === "latex" || block.type === "formula") {
    const html = block.content ? renderLatexSafe(block.content, block.accentSymbols) : null;
    body = html ? (
      <div
        className={`board-latex ${isWriting ? "chalk-hand-line is-ltr" : ""}`}
        dir="ltr"
        style={isWriting ? ({ animationDuration: "1.15s" } as CSSProperties) : undefined}
        onAnimationEnd={isWriting ? finishWriting : undefined}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    ) : (
      <ChalkText
        text={block.content}
        className="board-text"
        dir="ltr"
        animate={isWriting}
        inlineMath
        onDone={isWriting ? finishWriting : undefined}
      />
    );
  } else if (block.type === "svg") {
    const svg = block.content ? sanitizeSvgMarkup(block.content) : null;
    body = svg ? (
      <div
        className={`board-svg ${isWriting ? "chalk-hand-line is-ltr" : ""}`}
        style={isWriting ? ({ animationDuration: "0.95s" } as CSSProperties) : undefined}
        onAnimationEnd={isWriting ? finishWriting : undefined}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    ) : (
      <p className="board-text text-xs opacity-70" dir="auto">
        (ما قدرناش نرسمو هاد الشكل)
      </p>
    );
  } else if (mathHtml) {
    // A bare equation written as text/takeaway (e.g. a red final answer): typeset it.
    body = (
      <div
        className={`board-latex ${isWriting ? "chalk-hand-line is-ltr" : ""}`}
        dir="ltr"
        style={isWriting ? ({ animationDuration: "1.05s" } as CSSProperties) : undefined}
        onAnimationEnd={isWriting ? finishWriting : undefined}
        dangerouslySetInnerHTML={{ __html: mathHtml }}
      />
    );
  } else if (labelledMath) {
    // "Résultat : (c)' = 0" — keep the label handwritten, typeset only the equation.
    body = (
      <div className="board-labelled-math">
        <ChalkText text={labelledMath.label} className="board-text" animate={isWriting} />
        <div
          className={`board-latex ${isWriting ? "chalk-hand-line is-ltr" : ""}`}
          dir="ltr"
          style={
            isWriting
              ? ({ animationDuration: "1.05s", animationDelay: "0.45s" } as CSSProperties)
              : undefined
          }
          onAnimationEnd={isWriting ? finishWriting : undefined}
          dangerouslySetInnerHTML={{ __html: labelledMath.html }}
        />
      </div>
    );
  } else {
    body = (
      <ChalkText
        text={block.content}
        className={`board-text${block.type === "takeaway" ? " board-takeaway" : ""}`}
        animate={isWriting}
        inlineMath
        onDone={isWriting ? finishWriting : undefined}
      />
    );
  }

  return (
    <div className={classes} ref={rootRef} style={rootStyle} data-block-id={block.id}>
      {body}
      {/* The chalk frame mounts only once writing is done, so it draws itself
          right after the formula — fitted to the exact rendered size. */}
      {block.boxed && !isWriting ? <ChalkFrame color={CHALK_COLORS[block.color] ?? CHALK_COLORS.white} /> : null}
      {/* Circles / arrows / underlines appear once the block is fully written. */}
      {annotations.length && !isWriting ? <AnnotationLayer rootRef={rootRef} annotations={annotations} /> : null}
    </div>
  );
}

/**
 * Blocks are written ONE AT A TIME, in the order the tutor produced them, so a
 * turn that writes a definition, then a question, then an example reads as a
 * teacher writing them out in sequence while speaking — not three blocks
 * scribbled at once. Each block's own handwriting animation runs while it is the
 * active one, and the next block starts as soon as it finishes.
 */
function useSequentialWriting(blocks: BoardBlock[]) {
  const [writtenIds, setWrittenIds] = useState<string[]>([]);
  const written = useMemo(() => new Set(writtenIds), [writtenIds]);

  // Forget blocks that no longer exist (erased / replaced).
  useEffect(() => {
    const live = new Set(blocks.map((block) => block.id));
    setWrittenIds((previous) => {
      const next = previous.filter((id) => live.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [blocks]);

  // Blocks seeded before this session (PDF roadmap, restored lesson) are already
  // on the board: show them immediately instead of re-writing them.
  useEffect(() => {
    const alreadyThere = blocks.filter((block) => Date.now() - block.createdAt > 4000).map((block) => block.id);
    if (!alreadyThere.length) return;
    setWrittenIds((previous) => {
      const missing = alreadyThere.filter((id) => !previous.includes(id));
      return missing.length ? [...previous, ...missing] : previous;
    });
  }, [blocks]);

  const markWritten = useCallback((id: string) => {
    setWrittenIds((previous) => (previous.includes(id) ? previous : [...previous, id]));
  }, []);

  // The first block that has not been written yet is the one being written now.
  const activeBlock = blocks.find((block) => !written.has(block.id)) ?? null;

  return { written, activeBlock, markWritten };
}

function BoardZoneColumn({
  blocks,
  connectors,
  zoneClassName,
  label,
  onZoneOverflow,
}: {
  blocks: BoardBlock[];
  connectors: BoardConnector[];
  zoneClassName: string;
  label: string;
  /** The zone physically overflowed: drop its oldest erasable block. */
  onZoneOverflow?: (zone: BoardZone) => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { written, activeBlock, markWritten } = useSequentialWriting(blocks);

  // Physical overflow safety net: if the rendered content exceeds the zone
  // (which can happen when rendered height differs from the ink estimate),
  // drop the oldest erasable block so the board keeps flowing. This is a
  // fallback — insertPreparedBlock already auto-trims most of the time.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !onZoneOverflow || blocks.length < 2) return;
    const frame = requestAnimationFrame(() => {
      if (body.scrollHeight > body.clientHeight + 4) {
        onZoneOverflow(label === "examples" ? "right" : "middle");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [blocks, onZoneOverflow, label]);

  // Only draw a connector once BOTH of its blocks are done writing, so the
  // arrow appears after both ends actually exist on the board.
  const readyConnectors = useMemo(
    () => connectors.filter((connector) => written.has(connector.fromId) && written.has(connector.toId)),
    [connectors, written],
  );

  // Arrows run through a side margin so they never cut across text or each other:
  // pick each arrow's side (interleaving arrows go on opposite sides) and reserve
  // just enough margin for the lanes and labels — only while arrows exist.
  const connectorSides = useMemo(() => assignConnectorSides(readyConnectors, blocks), [readyConnectors, blocks]);
  const gutters = useMemo(() => connectorGutters(readyConnectors, connectorSides), [readyConnectors, connectorSides]);
  const gutterStyle: CSSProperties | undefined = readyConnectors.length
    ? ({
        paddingLeft: gutters.left ? `max(${(gutters.left * 14).toFixed(0)}px, ${(gutters.left * 1.79).toFixed(2)}cqw)` : undefined,
        paddingRight: gutters.right ? `max(${(gutters.right * 14).toFixed(0)}px, ${(gutters.right * 1.79).toFixed(2)}cqw)` : undefined,
      } as CSSProperties)
    : undefined;

  // Follow the writing: when the tutor writes below the visible part of the zone,
  // scroll just that zone (never the page) so the student sees what is being written.
  const activeId = activeBlock?.id ?? null;
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !activeId) return undefined;
    const timer = window.setTimeout(() => {
      const el = body.querySelector<HTMLElement>(`[data-block-id="${activeId}"]`);
      if (!el) return;
      const bodyRect = body.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      const top = rect.top - bodyRect.top + body.scrollTop;
      const bottom = top + rect.height;
      if (bottom > body.scrollTop + body.clientHeight - 6) {
        body.scrollTo({ top: Math.max(0, bottom - body.clientHeight + 18), behavior: "smooth" });
      } else if (top < body.scrollTop) {
        body.scrollTo({ top: Math.max(0, top - 10), behavior: "smooth" });
      }
    }, 140);
    return () => window.clearTimeout(timer);
  }, [activeId, blocks.length]);

  return (
    <div className={`board-zone ${zoneClassName}`} aria-label={label}>
      <div className="board-zone-body" ref={bodyRef} style={gutterStyle}>
        {blocks.length === 0 ? (
          <p className="board-zone-empty">…</p>
        ) : (
          blocks.map((block, blockIndex) =>
            written.has(block.id) || block.id === activeBlock?.id ? (
              <BoardBlockView
                key={block.id}
                block={block}
                blockIndex={blockIndex}
                active={block.id === activeBlock?.id}
                onWritten={markWritten}
              />
            ) : null,
          )
        )}
        {readyConnectors.length ? <ConnectorLayer zoneRef={bodyRef} connectors={readyConnectors} sides={connectorSides} /> : null}
      </div>
    </div>
  );
}

export function Blackboard({
  blocks,
  connectors = [],
  collapsed,
  onToggleCollapsed,
  onClear,
  onZoneOverflow,
  focus = false,
  onToggleFocus,
}: {
  blocks: BoardBlock[];
  /** Larger board view (the chat transcript is hidden while it is on). */
  focus?: boolean;
  onToggleFocus?: () => void;
  /** Cross-block flow / reference arrows (see board_connect). */
  connectors?: BoardConnector[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onClear: (zone?: BoardZone) => void;
  /** A zone physically overflowed: drop its oldest erasable block. */
  onZoneOverflow?: (zone: BoardZone) => void;
}) {
  const [notesState, setNotesState] = useState<"idle" | "copied" | "exporting" | "error">("idle");
  const hasNotes = useMemo(() => blocks.some((block) => block.type !== "question" && block.type !== "svg"), [blocks]);

  const copyNotes = async () => {
    const text = boardToNotes(blocks);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setNotesState("copied");
      window.setTimeout(() => setNotesState("idle"), 1800);
    } catch {
      void downloadNotesPdf();
    }
  };

  const downloadTextFallback = () => {
    // Fixed plain-text fallback: the anchor must be in the DOM for the
    // download to trigger reliably (bare link.click() fails in some browsers).
    const text = boardToNotes(blocks);
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `notes-${new Date().toISOString().slice(0, 10)}.txt`;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const downloadNotesPdf = async () => {
    if (notesState === "exporting") return;
    setNotesState("exporting");
    try {
      const { exportBoardToPdf } = await import("./exportPdf");
      await exportBoardToPdf(blocks);
      setNotesState("idle");
    } catch (error) {
      console.error("PDF export failed, falling back to text:", error);
      try {
        downloadTextFallback();
      } catch {
        // Ignore secondary failure; surface the error state below.
      }
      setNotesState("error");
      window.setTimeout(() => setNotesState("idle"), 2600);
    }
  };

  const { formal, right, formalConnectors, rightConnectors } = useMemo(
    () => ({
      formal: blocks.filter((block) => block.zone === "middle"),
      right: blocks.filter((block) => block.zone === "right"),
      formalConnectors: connectors.filter((connector) => connector.zone === "middle"),
      rightConnectors: connectors.filter((connector) => connector.zone === "right"),
    }),
    [blocks, connectors],
  );

  return (
    <div className={`board-wrap${focus ? " is-focus" : ""}`}>
      <div className="board-topbar">
        <div className="board-topbar-title">
          <Presentation className="h-4 w-4 text-[#ffe066]" />
          <span>السبورة</span>
          <span className="board-chalk-badge">2 Zones</span>
        </div>
        <div className="board-topbar-actions">
          {!collapsed && hasNotes && (
            <>
              <button
                type="button"
                className="board-mini-button"
                onClick={() => void copyNotes()}
                title="نسخ الملاحظات ديال السبورة"
                aria-label="نسخ الملاحظات"
              >
                {notesState === "copied" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {notesState === "copied" ? "تنسخات" : "نسخ الملاحظات"}
              </button>
              <button
                type="button"
                className="board-mini-button"
                onClick={() => void downloadNotesPdf()}
                disabled={notesState === "exporting"}
                title={notesState === "error" ? "تعذّر التصدير — عاود المحاولة" : "تحميل الملاحظات PDF"}
                aria-label="تحميل الملاحظات PDF"
              >
                {notesState === "exporting" ? (
                  <span className="button-spinner" aria-hidden="true" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                <span className="hidden sm:inline">
                  {notesState === "exporting" ? "جاري التصدير…" : notesState === "error" ? "عاود" : "PDF"}
                </span>
              </button>
            </>
          )}
          {!collapsed && onToggleFocus && (
            <button
              type="button"
              className="board-mini-button"
              onClick={onToggleFocus}
              aria-pressed={focus}
              title={focus ? "رجّع العرض العادي" : "كبّر السبورة"}
            >
              {focus ? <Shrink className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
              {focus ? "صغّر" : "كبّر"}
            </button>
          )}
          {!collapsed && (
            <button type="button" className="board-mini-button" onClick={() => onClear()}>
              <Eraser className="h-3.5 w-3.5" />
              مسح السبورة
            </button>
          )}
          <button
            type="button"
            className="board-mini-button"
            onClick={onToggleCollapsed}
            aria-pressed={!collapsed}
          >
            {collapsed ? <Maximize2 className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
            {collapsed ? "ورّي السبورة" : "خبّي السبورة"}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="board-frame" role="img" aria-label="السبورة ديال الأستاذ">
          <div className="board-zones board-zones-merged">
            <BoardZoneColumn
              blocks={formal}
              connectors={formalConnectors}
              zoneClassName="board-zone-formal"
              label="Formal French course content"
              onZoneOverflow={onZoneOverflow}
            />
            <BoardZoneColumn
              blocks={right}
              connectors={rightConnectors}
              zoneClassName="board-zone-right"
              label="examples"
              onZoneOverflow={onZoneOverflow}
            />
          </div>
        </div>
      )}
    </div>
  );
}
