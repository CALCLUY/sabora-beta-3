/**
 * Minimal, fast RFC-4180 CSV parser (handles quoted fields, escaped quotes,
 * CRLF line endings). Used to parse the raw DODa CSV files in the browser.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const n = text.length;
  let i = 0;
  let row: string[] = [];

  while (i < n) {
    let field: string;

    if (text.charCodeAt(i) === 34 /* " */) {
      i += 1;
      let buffer = "";
      let start = i;
      let closed = false;
      while (i < n) {
        if (text.charCodeAt(i) === 34) {
          if (text.charCodeAt(i + 1) === 34) {
            buffer += text.slice(start, i + 1);
            i += 2;
            start = i;
            continue;
          }
          buffer += text.slice(start, i);
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) buffer += text.slice(start, n);
      field = buffer;
      // Skip anything until the next delimiter (tolerates malformed rows).
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 44 || c === 10 || c === 13) break;
        i += 1;
      }
    } else {
      const start = i;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 44 || c === 10 || c === 13) break;
        i += 1;
      }
      field = text.slice(start, i);
    }

    row.push(field);

    if (i >= n) {
      rows.push(row);
      row = [];
      break;
    }

    const c = text.charCodeAt(i);
    if (c === 44 /* , */) {
      i += 1;
      if (i >= n) {
        row.push("");
        rows.push(row);
        row = [];
      }
      continue;
    }

    // Newline (\n or \r\n)
    if (c === 13 && text.charCodeAt(i + 1) === 10) i += 2;
    else i += 1;
    rows.push(row);
    row = [];
  }

  return rows;
}
