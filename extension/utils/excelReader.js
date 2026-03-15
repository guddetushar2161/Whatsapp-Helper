/**
 * Excel/CSV file reader and parser using SheetJS (XLSX global loaded via CDN)
 */
import { parsePhoneNumber, deduplicateContacts } from "./parser.js";

const PHONE_KEYWORDS = ["phone", "mobile", "number", "contact", "whatsapp", "tel", "cell", "ph", "mob"];
const NAME_KEYWORDS = ["name", "fullname", "full name", "first name", "contact name", "customer", "client"];

/**
 * Score a header string for likelihood of being a phone column
 */
function phoneScore(header) {
  const h = String(header).toLowerCase().trim();
  return PHONE_KEYWORDS.reduce((score, kw) => (h.includes(kw) ? score + 1 : score), 0);
}

/**
 * Score a header string for likelihood of being a name column
 */
function nameScore(header) {
  const h = String(header).toLowerCase().trim();
  return NAME_KEYWORDS.reduce((score, kw) => (h.includes(kw) ? score + 1 : score), 0);
}

/**
 * Heuristic: count how many cells in a column look like phone numbers
 */
function countPhoneLike(colValues) {
  return colValues.filter((v) => {
    const s = String(v).trim().replace(/[\s\-\.\(\)\+]/g, "");
    return /^\d{7,15}$/.test(s);
  }).length;
}

/**
 * Detect the best phone and name column indices from a sheet's data (array of arrays)
 * @param {any[][]} rows - Sheet data as array of rows (first row = headers if hasHeaders)
 * @param {boolean} hasHeaders
 * @returns {{ phoneCol: number, nameCol: number, dataStartRow: number }}
 */
function detectColumns(rows, hasHeaders) {
  if (!rows || rows.length === 0) return { phoneCol: 0, nameCol: -1, dataStartRow: 0 };

  let phoneCol = -1;
  let nameCol = -1;
  let dataStartRow = 0;

  if (hasHeaders && rows.length > 0) {
    const headers = rows[0];
    dataStartRow = 1;

    let bestPhoneScore = 0;
    let bestNameScore = 0;

    headers.forEach((h, i) => {
      const ps = phoneScore(h);
      const ns = nameScore(h);
      if (ps > bestPhoneScore) {
        bestPhoneScore = ps;
        phoneCol = i;
      }
      if (ns > bestNameScore) {
        bestNameScore = ns;
        nameCol = i;
      }
    });
  }

  // If header-based detection failed, scan data for most phone-like column
  if (phoneCol === -1 && rows.length > dataStartRow) {
    const dataRows = rows.slice(dataStartRow);
    const numCols = Math.max(...dataRows.map((r) => r.length));
    let bestCount = 0;
    for (let c = 0; c < numCols; c++) {
      const colVals = dataRows.map((r) => r[c]).filter(Boolean);
      const cnt = countPhoneLike(colVals);
      if (cnt > bestCount) {
        bestCount = cnt;
        phoneCol = c;
      }
    }
  }

  if (phoneCol === -1) phoneCol = 0;

  return { phoneCol, nameCol, dataStartRow };
}

/**
 * Read an Excel or CSV file and extract contacts
 * @param {File} file
 * @param {string} defaultCountryCode
 * @returns {Promise<{ contacts: Array<{name:string,phone:string,status:string}>, invalid: Array, warnings: string[] }>}
 */
export function readFile(file, defaultCountryCode = "91") {
  return new Promise((resolve, reject) => {
    if (typeof XLSX === "undefined") {
      reject(new Error("SheetJS (XLSX) library not loaded. Please check the CDN link in popup.html."));
      return;
    }

    const warnings = [];
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array", cellText: true, cellDates: true });

        if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
          reject(new Error("No sheets found in the workbook."));
          return;
        }

        if (workbook.SheetNames.length > 1) {
          warnings.push(`Multiple sheets detected. Using first sheet: "${workbook.SheetNames[0]}".`);
        }

        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        // Get data as array of arrays (raw values)
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });

        if (!rows || rows.length === 0) {
          reject(new Error("The file appears to be empty."));
          return;
        }

        // Determine if first row looks like a header row
        const firstRow = rows[0];
        const firstRowPhoneScore = firstRow.reduce((s, h) => s + phoneScore(h), 0);
        const hasHeaders = firstRowPhoneScore > 0 || firstRow.some((h) => nameScore(h) > 0);

        const { phoneCol, nameCol, dataStartRow } = detectColumns(rows, hasHeaders);

        if (phoneCol === -1) {
          reject(new Error("Could not detect a phone number column."));
          return;
        }

        const contacts = [];
        const invalid = [];

        for (let i = dataStartRow; i < rows.length; i++) {
          const row = rows[i];
          const rawPhone = row[phoneCol];
          const rawName = nameCol >= 0 ? row[nameCol] : "";

          if (!rawPhone || String(rawPhone).trim() === "") continue;

          const parsed = parsePhoneNumber(String(rawPhone), defaultCountryCode);
          const name = rawName ? String(rawName).trim() : "";

          if (parsed.valid) {
            contacts.push({ name, phone: parsed.phone, status: "pending" });
          } else {
            invalid.push({ name, phone: String(rawPhone).trim(), reason: parsed.reason, row: i + 1 });
          }
        }

        // Deduplicate
        const { unique, duplicates } = deduplicateContacts(contacts);
        if (duplicates.length > 0) {
          warnings.push(`${duplicates.length} duplicate number(s) were removed.`);
        }

        resolve({ contacts: unique, invalid, warnings });
      } catch (err) {
        reject(new Error(`Failed to parse file: ${err.message}`));
      }
    };

    reader.onerror = () => reject(new Error("Failed to read the file."));
    reader.readAsArrayBuffer(file);
  });
}
