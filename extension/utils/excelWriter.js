/**
 * Export contacts to XLSX or CSV using SheetJS (XLSX global loaded from local lib/xlsx.full.min.js)
 */

/**
 * Build worksheet rows from contacts array
 * @param {Array<{name:string, phone:string, status:string, timestamp?:string, notes?:string}>} contacts
 * @returns {any[][]}
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

/**
 * Export contacts to an XLSX file and trigger browser download
 * @param {Array<{name:string, phone:string, status:string, timestamp?:string, notes?:string}>} contacts
 * @param {string} filename - Output filename (without extension)
 */
export function exportToXlsx(contacts, filename = "whatsapp_report") {
  if (typeof XLSX === "undefined") {
    throw new Error("SheetJS (XLSX) library not loaded.");
  }

  const rows = buildRows(contacts);
  const ws = XLSX.utils.aoa_to_sheet(rows);

  // Column widths
  ws["!cols"] = [
    { wch: 25 },
    { wch: 20 },
    { wch: 12 },
    { wch: 22 },
    { wch: 35 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Report");

  XLSX.writeFile(wb, `${filename}.xlsx`);
}

/**
 * Export contacts to a CSV file and trigger browser download
 * @param {Array<{name:string, phone:string, status:string, timestamp?:string, notes?:string}>} contacts
 * @param {string} filename - Output filename (without extension)
 */
export function exportToCsv(contacts, filename = "whatsapp_report") {
  if (typeof XLSX === "undefined") {
    throw new Error("SheetJS (XLSX) library not loaded.");
  }

  const rows = buildRows(contacts);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(ws);

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
