/**
 * Beautiful PDF export of the blackboard notes.
 *
 * Renders the board into a clean, light-themed study document (white paper,
 * semantic colors and boxing preserved: yellow headings/key terms, boxed
 * definitions and key formulas, red takeaways, blue questions, Darija
 * examples), organized into sections, then captures it to a paginated A4 PDF.
 *
 * Implementation notes:
 * - Uses html-to-image (real browser rendering via SVG foreignObject) so KaTeX
 *   math, Arabic RTL and webfonts render exactly as on screen. All export styles
 *   are inline hex colors (no Tailwind classes) to keep capture deterministic.
 * - Uses jsPDF only as the PDF assembler; pages are sliced from the rendered
 *   image so long lessons span multiple pages cleanly.
 */
import katex from "katex";
import type { BoardAnnotation, BoardBlock } from "./types";
import { sanitizeSvgMarkup } from "./sanitizeSvg";

const PAGE_WIDTH_PX = 820;
const EXPORT_BG = "#ffffff";
const INK = "#1f2937";
const TEAL = "#264941";
const TEAL_DARK = "#1a332e";
const AMBER = "#b45309";
const AMBER_BORDER = "#d97706";
const AMBER_BG = "#fffbeb";
const RED = "#b91c1c";
const RED_BORDER = "#ef4444";
const RED_BG = "#fef2f2";
const BLUE = "#1d4ed8";
const BLUE_BORDER = "#3b82f6";
const BLUE_BG = "#eff6ff";
const GRAY_BORDER = "#cbd5e1";
const GRAY_BG = "#f8fafc";
const MUTED = "#6b7280";

const SANS = "'Segoe UI', system-ui, -apple-system, sans-serif";
const HAND = "'Caveat','Playpen Sans',cursive";
const ARABIC = "'Playpen Sans Arabic','Segoe UI',sans-serif";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDisplayMath(source: string): string {
  const clean = source.trim().replace(/^\\?\[|\\?\]$/g, "").replace(/^\$+|\$+$/g, "");
  try {
    return katex.renderToString(clean, { throwOnError: false, displayMode: true, strict: "ignore" });
  } catch {
    return `<code>${esc(source)}</code>`;
  }
}

function renderInlineMath(source: string): string {
  const clean = source.trim().replace(/^\$+|\$/g, "");
  try {
    return katex.renderToString(clean, { throwOnError: false, displayMode: false, strict: "ignore" });
  } catch {
    return `<code>${esc(source)}</code>`;
  }
}

/** Prose with $...$ math runs typeset + Arabic runs wrapped for RTL font. */
function renderRichText(raw: string): string {
  if (!raw) return "";
  return raw
    .split(/(\$[^$\n]+\$)/g)
    .map((chunk) => {
      if (chunk.startsWith("$") && chunk.endsWith("$") && chunk.length > 2) {
        return renderInlineMath(chunk.slice(1, -1));
      }
      return chunk
        .split(/([\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+)/gu)
        .map((segment) =>
          /[\u0600-\u06FF]/.test(segment)
            ? `<span dir="rtl" style="font-family:${ARABIC};">${esc(segment)}</span>`
            : esc(segment),
        )
        .join("");
    })
    .join("")
    .replace(/\n/g, "<br/>");
}

function annotationPills(annotations: BoardAnnotation[] | undefined): string {
  if (!annotations?.length) return "";
  const icon = { arrow: "→", circle: "○", underline: "＿" } as const;
  const pills = annotations
    .map((a) => {
      const label = a.label ? ` : ${esc(a.label)}` : "";
      return (
        `<span style="display:inline-block;background:#fef3c7;color:#92400e;` +
        `border-radius:999px;padding:2px 10px;font-size:12px;margin:2px 6px 2px 0;">` +
        `${icon[a.kind]} ${esc(a.target)}${label}</span>`
      );
    })
    .join("");
  return `<div style="margin-top:8px;">${pills}</div>`;
}

function blockHtml(block: BoardBlock): string {
  const items = block.items?.length ? block.items : null;
  switch (block.type) {
    case "heading":
      return (
        `<h2 style="font-family:${HAND};font-size:30px;font-weight:700;color:${TEAL};` +
        `border-bottom:4px solid #ffe066;padding-bottom:6px;margin:26px 0 12px;">` +
        `${renderRichText(block.content)}</h2>`
      );
    case "objective":
    case "list": {
      const list = items ?? (block.content ? [block.content] : []);
      if (!list.length) return "";
      const lis = list
        .map(
          (item) =>
            `<li style="margin:5px 0;line-height:1.7;"><span style="color:#0f7666;font-weight:700;">•</span> ${renderRichText(item)}</li>`,
        )
        .join("");
      return `<ul style="margin:8px 0;padding-left:22px;list-style:none;color:${INK};font-size:15px;">${lis}</ul>`;
    }
    case "definition": {
      const term = block.term?.trim() || "Définition";
      return (
        `<div style="border:2px solid ${AMBER_BORDER};border-radius:12px;padding:12px 18px;background:${AMBER_BG};margin:12px 0;">` +
        `<div style="font-weight:700;color:${AMBER};font-size:17px;">${renderRichText(term)}</div>` +
        `<div style="color:${INK};line-height:1.7;margin-top:4px;font-size:15px;">${renderRichText(block.content)}</div>` +
        `${annotationPills(block.annotations)}</div>`
      );
    }
    case "formula":
    case "latex": {
      const boxed = block.boxed;
      const badge = boxed
        ? `<div style="font-size:12px;font-weight:700;color:${AMBER};letter-spacing:1px;margin-bottom:6px;">★ À RETENIR</div>`
        : "";
      return (
        `<div style="background:${GRAY_BG};border:${boxed ? `2.5px solid #eab308` : `2px solid ${GRAY_BORDER}`};` +
        `border-radius:12px;padding:14px 16px;margin:12px 0;text-align:center;font-size:17px;color:${INK};">` +
        `${badge}${block.content ? renderDisplayMath(block.content) : ""}${annotationPills(block.annotations)}</div>`
      );
    }
    case "takeaway":
      return (
        `<div style="background:${RED_BG};border:2px solid ${RED_BORDER};border-radius:12px;padding:12px 18px;` +
        `margin:12px 0;color:${RED};font-weight:700;font-size:16px;line-height:1.7;">` +
        `✓ ${renderRichText(block.content)}${annotationPills(block.annotations)}</div>`
      );
    case "question":
      return (
        `<div style="background:${BLUE_BG};border:2px solid ${BLUE_BORDER};border-radius:12px;padding:12px 18px;margin:12px 0;">` +
        `<div style="font-weight:700;color:${BLUE};font-size:15px;">Question :</div>` +
        `<div style="color:${INK};line-height:1.7;margin-top:4px;font-size:15px;">${renderRichText(block.content)}</div></div>`
      );
    case "example": {
      const rawTitle = (block.title ?? "").trim().replace(/^(?:exemples?|examples?|ex\.?)(?=[\s:'’]|$)\s*(?:de\s+|d['’]\s*|:\s*)?/i, "").replace(/\s*[:：]\s*$/, "").trim();
      const heading = rawTitle ? `Exemple de ${esc(rawTitle)} :` : "Exemple :";
      const body = items ? items.map((i) => renderRichText(i)).join("<br/>") : renderRichText(block.content);
      return (
        `<div style="background:${AMBER_BG};border-left:5px solid #f59e0b;border-radius:0 12px 12px 0;` +
        `padding:12px 18px;margin:12px 0;">` +
        `<div dir="ltr" style="color:${AMBER};font-weight:700;font-size:15px;">${heading}</div>` +
        `<div dir="rtl" style="text-align:right;font-family:${ARABIC};line-height:1.9;color:${INK};font-size:15px;margin-top:6px;">${body}</div>` +
        `${annotationPills(block.annotations)}</div>`
      );
    }
    case "svg": {
      const svg = block.content ? sanitizeSvgMarkup(block.content) : null;
      if (!svg) return "";
      const fitted = svg.replace(/<svg/i, '<svg style="max-width:100%;height:auto;"');
      return `<div style="text-align:center;margin:12px 0;color:${INK};">${fitted}</div>`;
    }
    default:
      if (!block.content.trim() && !items) return "";
      return `<p style="color:${INK};line-height:1.7;margin:8px 0;font-size:15px;">${renderRichText(items ? items.join("\n") : block.content)}${annotationPills(block.annotations)}</p>`;
  }
}

type NotesStats = { definitions: number; formulas: number; examples: number; takeaways: number };

function buildNotesHtml(blocks: BoardBlock[], title: string): { html: string; stats: NotesStats } {
  const formal = blocks
    .filter((b) => b.zone !== "right")
    .sort((a, b) => a.createdAt - b.createdAt);
  const examples = blocks
    .filter((b) => b.zone === "right")
    .sort((a, b) => a.createdAt - b.createdAt);

  const stats: NotesStats = {
    definitions: formal.filter((b) => b.type === "definition").length,
    formulas: formal.filter((b) => b.type === "formula" || b.type === "latex").length,
    examples: examples.length,
    takeaways: formal.filter((b) => b.type === "takeaway").length,
  };

  // Group formal content into sections split by headings.
  const sections: { heading: string; blocks: BoardBlock[] }[] = [];
  let current: { heading: string; blocks: BoardBlock[] } | null = null;
  for (const block of formal) {
    if (block.type === "heading") {
      current = { heading: block.content, blocks: [] };
      sections.push(current);
    } else {
      if (!current) {
        current = { heading: "", blocks: [] };
        sections.push(current);
      }
      current.blocks.push(block);
    }
  }

  const date = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const firstHeading = formal.find((b) => b.type === "heading")?.content;
  const docTitle = title || firstHeading || "Notes du cours";

  let html =
    `<div style="font-family:${SANS};color:${INK};">` +
    `<div style="border-bottom:3px solid ${TEAL};padding-bottom:14px;margin-bottom:6px;">` +
    `<div style="font-size:13px;font-weight:700;letter-spacing:2px;color:${MUTED};">الأستاذ VOX · FICHE DE RÉVISION</div>` +
    `<div style="font-size:26px;font-weight:800;color:${TEAL_DARK};margin-top:4px;line-height:1.3;">${renderRichText(docTitle)}</div>` +
    `<div style="font-size:13px;color:${MUTED};margin-top:6px;">${esc(date)} · ${stats.definitions} définition(s) · ${stats.formulas} formule(s) · ${stats.examples} exemple(s) · ${stats.takeaways} point(s) clé(s)</div>` +
    `</div>`;

  if (!formal.length && !examples.length) {
    html += `<p style="color:${MUTED};font-size:15px;">Rien à exporter pour le moment — la planche est vide.</p></div>`;
    return { html, stats };
  }

  for (const section of sections) {
    if (section.heading) {
      html +=
        `<h2 style="font-family:${HAND};font-size:29px;font-weight:700;color:${TEAL};` +
        `border-bottom:4px solid #ffe066;padding-bottom:4px;margin:26px 0 10px;">${renderRichText(section.heading)}</h2>`;
    } else if (sections.length > 1 || examples.length) {
      html += `<h2 style="font-size:19px;font-weight:800;color:${TEAL};margin:24px 0 8px;">Cours</h2>`;
    }
    for (const block of section.blocks) html += blockHtml(block);
  }

  if (examples.length) {
    html +=
      `<h2 style="font-size:19px;font-weight:800;color:${TEAL};margin:26px 0 8px;">Exemples <span dir="rtl" style="font-family:${ARABIC};font-weight:400;font-size:16px;">— أمثلة</span></h2>`;
    for (const block of examples) html += blockHtml(block);
  }

  html +=
    `<div style="margin-top:28px;padding-top:10px;border-top:1px solid #e5e7eb;font-size:12px;color:${MUTED};">` +
    `Généré par الأستاذ Vox — relis, cache, récite : la récupération active fixe la mémoire.</div></div>`;
  return { html, stats };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image-load-failed"));
    img.src = src;
  });
}

/**
 * Exports the board as a beautiful, paginated A4 PDF and triggers the download.
 * Throws on failure so the caller can fall back to plain-text export.
 */
export async function exportBoardToPdf(blocks: BoardBlock[], title?: string): Promise<{ pages: number }> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    throw new Error("pdf-export-requires-browser");
  }
  const [{ toPng }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);

  const { html } = buildNotesHtml(blocks, title ?? "");
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-12000px;top:0;width:${PAGE_WIDTH_PX}px;background:${EXPORT_BG};padding:52px 54px 60px;box-sizing:border-box;`;
  host.innerHTML = html;
  document.body.appendChild(host);

  try {
    try {
      await document.fonts.ready;
      await Promise.all([
        document.fonts.load('700 30px Caveat').catch(() => []),
        document.fonts.load('500 16px "Playpen Sans Arabic"').catch(() => []),
      ]);
    } catch {
      // Fonts are best-effort; fall back to system fonts.
    }
    // Let webfonts and KaTeX settle before capture.
    await new Promise((resolve) => window.setTimeout(resolve, 250));

    // Cap render scale for very tall boards so the canvas stays within browser limits.
    const renderedHeight = host.scrollHeight || 1000;
    const pixelRatio = renderedHeight * 2 > 14000 ? 1.25 : 2;
    const dataUrl = await toPng(host, {
      cacheBust: true,
      backgroundColor: EXPORT_BG,
      pixelRatio,
    });
    const img = await loadImage(dataUrl);

    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const pageW = 210;
    const pageH = 297;
    const margin = 11;
    const usableW = pageW - margin * 2;
    const usableH = pageH - margin * 2 - 8; // room for footer
    const pxPerMm = img.width / usableW;
    const sliceHpx = Math.max(1, Math.floor(usableH * pxPerMm));

    let y = 0;
    let page = 0;
    while (y < img.height) {
      const h = Math.min(sliceHpx, img.height - y);
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("pdf-canvas-unavailable");
      ctx.fillStyle = EXPORT_BG;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, y, img.width, h, 0, 0, img.width, h);
      if (page > 0) pdf.addPage();
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", margin, margin, usableW, h / pxPerMm);
      pdf.setFontSize(9);
      pdf.setTextColor(150, 150, 150);
      pdf.text(`Page ${page + 1}`, pageW / 2, pageH - 7, { align: "center" });
      y += h;
      page += 1;
      if (page > 30) break; // sanity cap
    }

    const stamp = new Date().toISOString().slice(0, 10);
    pdf.save(`vox-notes-${stamp}.pdf`);
    return { pages: page };
  } finally {
    host.remove();
  }
}
