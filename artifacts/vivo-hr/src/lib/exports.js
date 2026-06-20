import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export function exportToExcel(rows, filename = "vivo-export.xlsx", sheetName = "Sheet1") {
  if (!rows || rows.length === 0) {
    rows = [{ note: "No data available" }];
  }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

export function exportToPDF({
  title = "Vivo HR Report",
  subtitle = "",
  headers = [],
  rows = [],
  filename = "vivo-report.pdf",
} = {}) {
  const doc = new jsPDF({ orientation: rows[0]?.length > 6 ? "landscape" : "portrait" });
  // Header bar — forest green
  doc.setFillColor(26, 92, 56);
  doc.rect(0, 0, doc.internal.pageSize.getWidth(), 18, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("VIVO FASHION GROUP", 14, 11);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("HR Attendance Dashboard", doc.internal.pageSize.getWidth() - 60, 11);

  doc.setTextColor(20, 20, 28);
  doc.setFontSize(15);
  doc.setFont("helvetica", "bold");
  doc.text(title, 14, 28);
  if (subtitle) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(110, 110, 120);
    doc.text(subtitle, 14, 34);
  }
  doc.setTextColor(140, 140, 150);
  doc.setFontSize(8);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 39);

  autoTable(doc, {
    startY: 44,
    head: [headers],
    body: rows,
    theme: "striped",
    styles: { fontSize: 8, cellPadding: 2.5 },
    headStyles: { fillColor: [26, 92, 56], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [253, 248, 240] },
    margin: { left: 14, right: 14 },
  });

  doc.save(filename);
}
