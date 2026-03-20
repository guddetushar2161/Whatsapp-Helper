/**
 * Export contacts to XLSX or CSV — no external library required.
 *
 * XLSX is generated as a minimal OOXML package (uncompressed ZIP) so it opens
 * correctly in Excel, LibreOffice, and Google Sheets without any third-party
 * dependency.
 */

/**
 * Build worksheet rows from contacts array
 * @param {Array<{name:string, phone:string, status:string, timestamp?:string, notes?:string}>} contacts
 * @returns {string[][]}
 */
function buildRows(contacts) {
  const header = ["Name", "Phone", "Status", "Timestamp", "Notes"];
  const rows = contacts.map((c) => [
    c.name || "",
    c.phone || "",
    c.status || "pending",
    c.timestamp || "",
    c.notes || "",
  ]);
  return [header, ...rows];
}

// ── CSV ───────────────────────────────────────────────────────────────────────

function escapeCell(value) {
  const s = String(value == null ? "" : value);
  // Quote if the cell contains a comma, double-quote, or newline
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Export contacts to a CSV file and trigger browser download
 * @param {Array<{name:string, phone:string, status:string, timestamp?:string, notes?:string}>} contacts
 * @param {string} filename - Output filename (without extension)
 */
export function exportToCsv(contacts, filename = "whatsapp_report") {
  const rows = buildRows(contacts);
  const csv = rows.map((row) => row.map(escapeCell).join(",")).join("\r\n");

  // BOM ensures Excel opens UTF-8 CSV correctly
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, `${filename}.csv`);
}

// ── XLSX (OOXML, uncompressed ZIP) ────────────────────────────────────────────

function xmlEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convert column index (0-based) to Excel letter(s): 0→A, 25→Z, 26→AA */
function colLetter(idx) {
  let s = "";
  let n = idx + 1; // convert to 1-based
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildSheetXml(rows) {
  let xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    "<sheetData>";

  rows.forEach((row, ri) => {
    xml += `<row r="${ri + 1}">`;
    row.forEach((cell, ci) => {
      const addr = colLetter(ci) + (ri + 1);
      xml += `<c r="${addr}" t="inlineStr"><is><t>${xmlEsc(cell)}</t></is></c>`;
    });
    xml += "</row>";
  });

  xml += "</sheetData></worksheet>";
  return xml;
}

/** CRC-32 table (IEEE polynomial) */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ b) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n) {
  return [(n >>> 0) & 0xff, (n >>> 8) & 0xff];
}

function u32(n) {
  return [(n >>> 0) & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** Build a valid ZIP archive (store method, no compression) from a name→string map */
function packZip(fileMap) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);

  const entries = [];
  const localParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(fileMap)) {
    const nameBytes = enc.encode(name);
    const dataBytes = enc.encode(content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    // Local file header
    const lfh = [
      0x50, 0x4b, 0x03, 0x04, // signature
      20, 0,                   // version needed
      0, 0,                    // general-purpose flag
      0, 0,                    // compression: store
      ...u16(dosTime),
      ...u16(dosDate),
      ...u32(crc),
      ...u32(size),            // compressed size
      ...u32(size),            // uncompressed size
      ...u16(nameBytes.length),
      0, 0,                    // extra field length
      ...nameBytes,
    ];

    localParts.push(new Uint8Array(lfh), dataBytes);
    entries.push({ nameBytes, crc, size, offset });
    offset += lfh.length + size;
  }

  // Central directory
  const cdParts = [];
  for (const e of entries) {
    const cde = [
      0x50, 0x4b, 0x01, 0x02, // signature
      20, 0,                   // version made by
      20, 0,                   // version needed
      0, 0,                    // flag
      0, 0,                    // compression: store
      ...u16(dosTime),
      ...u16(dosDate),
      ...u32(e.crc),
      ...u32(e.size),
      ...u32(e.size),
      ...u16(e.nameBytes.length),
      0, 0,                    // extra field length
      0, 0,                    // file comment length
      0, 0,                    // disk start
      0, 0,                    // internal attr
      0, 0, 0, 0,              // external attr
      ...u32(e.offset),
      ...e.nameBytes,
    ];
    cdParts.push(new Uint8Array(cde));
  }

  const cdSize = cdParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, // signature
    0, 0,                    // disk number
    0, 0,                    // disk with CD
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(cdSize),
    ...u32(offset),
    0, 0,                    // comment length
  ]);

  // Concatenate all parts
  const allParts = [...localParts, ...cdParts, eocd];
  const total = allParts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of allParts) {
    out.set(part, pos);
    pos += part.length;
  }

  return new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function buildXlsxBlob(rows) {
  const sheetXml = buildSheetXml(rows);

  return packZip({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      "</Types>",

    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",

    "xl/workbook.xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets>' +
      "</workbook>",

    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      "</Relationships>",

    "xl/worksheets/sheet1.xml": sheetXml,
  });
}

/**
 * Export contacts to an XLSX file and trigger browser download.
 * Note: column auto-sizing is not included in this minimal OOXML implementation.
 * @param {Array<{name:string, phone:string, status:string, timestamp?:string, notes?:string}>} contacts
 * @param {string} filename - Output filename (without extension)
 */
export function exportToXlsx(contacts, filename = "whatsapp_report") {
  const rows = buildRows(contacts);
  const blob = buildXlsxBlob(rows);
  triggerDownload(blob, `${filename}.xlsx`);
}

// ── Shared download helper ────────────────────────────────────────────────────

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

