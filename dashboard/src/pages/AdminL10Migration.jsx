import React, { useRef, useState } from "react";
import { api } from "@/lib/api";
import { ArrowSquareOut, UploadSimple, CheckCircle, Warning, Database, CircleNotch } from "@phosphor-icons/react";

/**
 * Admin — L10 Data Migration
 *
 * Export: GET /api/admin/l10/export → downloads the full L10 snapshot as a JSON file.
 * Import: file picker → parse JSON → row-count preview → confirm → POST /api/admin/l10/import.
 */
const AdminL10Migration = () => {
  // ── Export ────────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const { data } = await api.get("/admin/l10/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.download = `l10-snapshot-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e?.response?.data?.detail || e.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  // ── Import ────────────────────────────────────────────────────────────────
  const fileRef = useRef(null);
  const [parsed, setParsed] = useState(null);   // parsed snapshot from the file
  const [parseError, setParseError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);  // { imported, total_rows, folder_ids }
  const [importError, setImportError] = useState(null);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsed(null);
    setParseError(null);
    setImportResult(null);
    setImportError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data?.tables || !data?.row_counts) {
          throw new Error("File does not look like an L10 snapshot (missing tables or row_counts).");
        }
        setParsed(data);
      } catch (err) {
        setParseError(err.message);
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!parsed) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const { data } = await api.post("/admin/l10/import", parsed);
      setImportResult(data);
      setParsed(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setImportError(e?.response?.data?.detail || e.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleCancel = () => {
    setParsed(null);
    setParseError(null);
    setImportResult(null);
    setImportError(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="space-y-8" data-testid="admin-l10-migration-page">
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div>
        <div className="eyebrow">Admin · L10</div>
        <h1 className="font-extrabold tracking-tight mt-1 leading-[1.15] line-clamp-2 text-[clamp(15px,1.5vw,19px)] inline-flex items-center gap-2">
          <Database size={22} weight="duotone" className="text-[#1a5c38]" />
          L10 Data Migration
        </h1>
        <p className="text-muted text-[13px] mt-1 max-w-2xl">
          Move L10 meeting data between environments without needing curl. Export a
          snapshot from the source environment, then import it here.
        </p>
      </div>

      {/* ── Export card ──────────────────────────────────────────────────── */}
      <section className="card-white p-5 space-y-3" data-testid="l10-export-section">
        <div>
          <h2 className="text-[14px] font-bold">Export snapshot</h2>
          <p className="text-[12.5px] text-muted mt-0.5">
            Downloads a JSON file containing all L10 folders, meetings, members,
            rocks, scorecard metrics, and history from this environment.
          </p>
        </div>

        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          data-testid="l10-export-btn"
          className="inline-flex items-center gap-2 text-[12.5px] font-semibold bg-[#1a5c38] text-white px-4 py-2 rounded-md hover:bg-[#154d30] disabled:opacity-50 transition-colors"
        >
          {exporting ? (
            <><ArrowSquareOut size={14} className="animate-spin" /> Exporting…</>
          ) : (
            <><ArrowSquareOut size={14} /> Export &amp; Download</>
          )}
        </button>

        {exportError && (
          <div className="flex items-start gap-2 text-[12.5px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2" data-testid="l10-export-error">
            <Warning size={14} weight="fill" className="mt-0.5 shrink-0" />
            {exportError}
          </div>
        )}
      </section>

      {/* ── Import card ──────────────────────────────────────────────────── */}
      <section className="card-white p-5 space-y-4" data-testid="l10-import-section">
        <div>
          <h2 className="text-[14px] font-bold">Import snapshot</h2>
          <p className="text-[12.5px] text-muted mt-0.5">
            Select a JSON file exported from another environment. The import
            replaces all folders and their data that are present in the file —
            any folders <em>not</em> in the file are left untouched.
          </p>
        </div>

        {/* File picker */}
        {!parsed && !importResult && (
          <label
            className="flex items-center gap-3 cursor-pointer border-2 border-dashed border-border rounded-lg px-4 py-5 hover:border-brand/50 transition-colors"
            data-testid="l10-import-dropzone"
          >
            <UploadSimple size={22} className="text-muted shrink-0" />
            <div>
              <span className="text-[13px] font-semibold text-foreground">Choose a snapshot file</span>
              <span className="text-[12px] text-muted ml-2">(.json)</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              onChange={handleFileChange}
              data-testid="l10-import-file-input"
            />
          </label>
        )}

        {/* Parse error */}
        {parseError && (
          <div className="flex items-start gap-2 text-[12.5px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2" data-testid="l10-parse-error">
            <Warning size={14} weight="fill" className="mt-0.5 shrink-0" />
            {parseError}
            <button type="button" onClick={handleCancel} className="ml-auto underline text-red-600 hover:text-red-800">Clear</button>
          </div>
        )}

        {/* Row-count preview */}
        {parsed && !importResult && (
          <div className="space-y-3" data-testid="l10-import-preview">
            <div className="text-[12.5px] font-semibold text-foreground">
              Snapshot preview
              <span className="ml-2 text-muted font-normal">
                exported {parsed.exported_at ? new Date(parsed.exported_at).toLocaleString() : "unknown"}
              </span>
            </div>
            <div className="overflow-x-auto rounded-md border border-border" data-testid="l10-preview-table">
              <table className="w-full text-[12px]">
                <thead className="bg-panel">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-muted">Table</th>
                    <th className="text-right px-3 py-2 font-semibold text-muted">Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(parsed.row_counts).map(([tbl, n]) => (
                    <tr key={tbl} className="border-t border-border">
                      <td className="px-3 py-1.5 font-mono text-foreground">{tbl}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{n.toLocaleString()}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-border bg-panel">
                    <td className="px-3 py-1.5 font-semibold">Total</td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                      {Object.values(parsed.row_counts).reduce((s, n) => s + n, 0).toLocaleString()}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {importError && (
              <div className="flex items-start gap-2 text-[12.5px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2" data-testid="l10-import-error">
                <Warning size={14} weight="fill" className="mt-0.5 shrink-0" />
                {importError}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleImport}
                disabled={importing}
                data-testid="l10-import-confirm-btn"
                className="inline-flex items-center gap-2 text-[12.5px] font-semibold bg-[#1a5c38] text-white px-4 py-2 rounded-md hover:bg-[#154d30] disabled:opacity-50 transition-colors"
              >
                {importing ? <><CircleNotch size={13} className="animate-spin" /> Importing…</> : <>Confirm Import</>}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={importing}
                data-testid="l10-import-cancel-btn"
                className="text-[12.5px] font-semibold text-muted border border-border px-4 py-2 rounded-md hover:bg-panel disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Success result */}
        {importResult && (
          <div className="space-y-3" data-testid="l10-import-result">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-4 py-3">
              <CheckCircle size={16} weight="fill" className="shrink-0" />
              Import complete — {importResult.total_rows?.toLocaleString() ?? 0} rows written
              {importResult.folder_ids?.length > 0 && (
                <span className="ml-2 text-[11.5px] font-normal text-emerald-600">
                  (folder{importResult.folder_ids.length !== 1 ? "s" : ""} {importResult.folder_ids.join(", ")})
                </span>
              )}
            </div>
            <div className="overflow-x-auto rounded-md border border-border" data-testid="l10-result-table">
              <table className="w-full text-[12px]">
                <thead className="bg-panel">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-muted">Table</th>
                    <th className="text-right px-3 py-2 font-semibold text-muted">Rows inserted</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(importResult.imported).map(([tbl, n]) => (
                    <tr key={tbl} className="border-t border-border">
                      <td className="px-3 py-1.5 font-mono text-foreground">{tbl}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{n.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              onClick={handleCancel}
              className="text-[12px] text-muted underline hover:text-foreground"
            >
              Import another file
            </button>
          </div>
        )}
      </section>
    </div>
  );
};

export default AdminL10Migration;
