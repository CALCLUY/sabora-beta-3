/**
 * Minimal allow-list sanitizer for model-generated SVG diagrams/flowcharts
 * before they are injected into the DOM with dangerouslySetInnerHTML.
 */
const ALLOWED_TAGS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "ellipse",
  "defs",
  "marker",
  "lineargradient",
  "radialgradient",
  "stop",
  "title",
]);

const BLOCKED_ATTR_PREFIXES = ["on"];
const BLOCKED_ATTR_NAMES = new Set(["href", "xlink:href"]);

function sanitizeElement(node: Element): void {
  const tag = node.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) {
    node.remove();
    return;
  }
  Array.from(node.attributes).forEach((attr) => {
    const name = attr.name.toLowerCase();
    const value = attr.value.trim().toLowerCase();
    if (BLOCKED_ATTR_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      node.removeAttribute(attr.name);
      return;
    }
    if (BLOCKED_ATTR_NAMES.has(name)) {
      node.removeAttribute(attr.name);
      return;
    }
    if (value.startsWith("javascript:") || value.startsWith("data:text/html")) {
      node.removeAttribute(attr.name);
    }
  });
  Array.from(node.children).forEach((child) => sanitizeElement(child));
}

/** Returns sanitized, serialized SVG markup, or null if the input isn't usable. */
export function sanitizeSvgMarkup(raw: string): string | null {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") return null;
  const match = raw.match(/<svg[\s\S]*?<\/svg>/i);
  const source = (match ? match[0] : raw.trim().startsWith("<svg") ? raw : "").trim();
  if (!source) return null;
  try {
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    if (doc.querySelector("parsererror")) return null;
    const root = doc.documentElement;
    if (root.tagName.toLowerCase() !== "svg") return null;
    root.removeAttribute("width");
    root.removeAttribute("height");
    if (!root.getAttribute("viewBox")) root.setAttribute("viewBox", "0 0 400 240");
    sanitizeElement(root);
    return new XMLSerializer().serializeToString(root);
  } catch {
    return null;
  }
}
