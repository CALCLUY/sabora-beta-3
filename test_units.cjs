const katex = require('katex');

// Let's test how MathInline and toUnits work with:
// "Soit $z = a + ib$ et son conjugué $\\bar{z} = a - ib"

function MathInline(text) {
  // Currently in Board.tsx:
  // const clean = text.replace(/\$/g, "").trim();
  // const html = katex.renderToString(clean, { throwOnError: false, displayMode: false, strict: "ignore" });
  const clean = text.replace(/\$/g, "").trim();
  return katex.renderToString(clean, { throwOnError: false, displayMode: false, strict: "ignore" });
}

// Let's test tokenizeText and toUnits
