/**
 * Local PDF reading with pdf.js (runs entirely in the browser).
 * Used for page count, a text layer for the tutor, and a fallback when the
 * Gemini document analysis is unavailable.
 */
import { getDocument, GlobalWorkerOptions, version } from "pdfjs-dist";

let workerReady = false;
function ensureWorker() {
  if (workerReady) return;
  GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.worker.min.mjs`;
  workerReady = true;
}

export type ExtractedPage = { page: number; text: string };

export type ExtractedPdf = {
  pageCount: number;
  pages: ExtractedPage[];
  totalChars: number;
  /** True when most pages have almost no text layer (scanned / photographed). */
  looksScanned: boolean;
};

export class PdfReadError extends Error {
  constructor(
    message: string,
    readonly code: "password" | "invalid" | "unknown",
  ) {
    super(message);
  }
}

type TextItemLike = { str?: string; hasEOL?: boolean };

export async function extractPdfText(data: ArrayBuffer, maxPages = 120): Promise<ExtractedPdf> {
  ensureWorker();
  // pdf.js transfers the buffer to the worker, so give it a copy.
  const task = getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    const name = (error as { name?: string })?.name ?? "";
    if (name === "PasswordException") throw new PdfReadError("PDF محمي بكلمة السر.", "password");
    if (name === "InvalidPDFException") throw new PdfReadError("الملف ماشي PDF صالح.", "invalid");
    throw new PdfReadError("ما قدرناش نقراو هاد الـ PDF.", "unknown");
  }

  const pages: ExtractedPage[] = [];
  const limit = Math.min(pdf.numPages, maxPages);
  let lowTextPages = 0;
  for (let number = 1; number <= limit; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    let text = "";
    for (const raw of content.items as TextItemLike[]) {
      if (typeof raw.str !== "string") continue;
      text += raw.str;
      text += raw.hasEOL ? "\n" : " ";
    }
    text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 40) lowTextPages += 1;
    pages.push({ page: number, text });
    page.cleanup();
  }
  const pageCount = pdf.numPages;
  await pdf.destroy();

  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  return { pageCount, pages, totalChars, looksScanned: limit > 0 && lowTextPages / limit > 0.6 };
}
