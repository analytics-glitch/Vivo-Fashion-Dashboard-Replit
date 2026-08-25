import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Info,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { customerWorkbook } from "@/data/customerWorkbook";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  buildCombinedCsv,
  reportFilename,
  type CustomerWorkbook,
  type ReportWorksheet,
} from "@/lib/csv";

type LoadState = "loading" | "ready" | "empty" | "error";
type DownloadState = "idle" | "working" | "success" | "error";

const sheetId = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const workbookIsValid = (value: unknown): value is CustomerWorkbook => {
  if (!value || typeof value !== "object") return false;
  const workbook = value as Partial<CustomerWorkbook>;
  return (
    typeof workbook.sourceFile === "string" &&
    Array.isArray(workbook.worksheets) &&
    workbook.worksheets.every(
      (worksheet) =>
        typeof worksheet.name === "string" &&
        typeof worksheet.maxColumn === "number" &&
        Array.isArray(worksheet.columns) &&
        Array.isArray(worksheet.rows) &&
        worksheet.rows.every(
          (row: { rowNumber?: unknown; cells?: unknown }) =>
            typeof row.rowNumber === "number" && Array.isArray(row.cells),
        ),
    )
  );
};

function LoadingState() {
  return (
    <div className="space-y-5" data-testid="state-loading" aria-live="polite">
      <div className="flex gap-2">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-10 w-44" />
        <Skeleton className="h-10 w-32" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-80" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton className="h-11 w-full" key={index} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusMessage({
  kind,
  onRetry,
}: {
  kind: "empty" | "error";
  onRetry: () => void;
}) {
  const error = kind === "error";
  return (
    <Card
      className={error ? "border-destructive/30 bg-destructive/[0.03]" : ""}
      data-testid={`state-${kind}`}
    >
      <CardContent className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
        {error ? (
          <AlertCircle className="mb-4 h-10 w-10 text-destructive" />
        ) : (
          <FileSpreadsheet className="mb-4 h-10 w-10 text-muted-foreground/50" />
        )}
        <h2 className="text-lg font-semibold">
          {error ? "Parsing error" : "Empty workbook"}
        </h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          {error
            ? "The supplied source could not be read as a workbook. Try loading it again."
            : "The supplied workbook has no worksheets to preview."}
        </p>
        <Button
          className="mt-6"
          onClick={onRetry}
          variant="outline"
          data-testid={`button-retry-${kind}`}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

function WorksheetPreview({ worksheet }: { worksheet: ReportWorksheet }) {
  return (
    <Card className="overflow-hidden" data-testid={`panel-${sheetId(worksheet.name)}`}>
      <CardHeader className="gap-1 border-b bg-muted/20 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <CardTitle className="text-lg">{worksheet.name}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Source layout preserved · {worksheet.rows.length.toLocaleString()} rows ·{" "}
              {worksheet.maxColumn} columns
            </p>
          </div>
          <span className="font-mono text-xs text-muted-foreground">
            columns {worksheet.columns[0]}–{worksheet.columns.at(-1)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="worksheet-scroll" data-testid={`scroll-${sheetId(worksheet.name)}`}>
          <table className="worksheet-table" data-testid={`table-${sheetId(worksheet.name)}`}>
            <thead>
              <tr>
                <th className="worksheet-row-number" scope="col">
                  #
                </th>
                {worksheet.columns.map((column) => (
                  <th key={column} scope="col" data-testid={`column-${sheetId(worksheet.name)}-${column}`}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {worksheet.rows.map((row) => (
                <tr key={row.rowNumber} data-testid={`row-${sheetId(worksheet.name)}-${row.rowNumber}`}>
                  <th className="worksheet-row-number" scope="row">
                    {row.rowNumber}
                  </th>
                  {worksheet.columns.map((column, columnIndex) => (
                    <td
                      key={column}
                      data-testid={`cell-${sheetId(worksheet.name)}-${row.rowNumber}-${column}`}
                    >
                      {row.cells[columnIndex] || ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Home() {
  const [workbook, setWorkbook] = useState<CustomerWorkbook | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [activeSheet, setActiveSheet] = useState(0);
  const [downloadState, setDownloadState] = useState<DownloadState>("idle");
  const { toast } = useToast();

  const loadWorkbook = () => {
    setLoadState("loading");
    setWorkbook(null);
    const timer = window.setTimeout(() => {
      try {
        if (!workbookIsValid(customerWorkbook)) {
          throw new Error("Invalid workbook structure");
        }
        setWorkbook(customerWorkbook);
        setActiveSheet(0);
        setLoadState(customerWorkbook.worksheets.length ? "ready" : "empty");
      } catch (error) {
        console.error("Customer workbook parsing failed", error);
        setLoadState("error");
      }
    }, 450);
    return () => window.clearTimeout(timer);
  };

  useEffect(() => loadWorkbook(), []);

  const totalRows = useMemo(
    () => workbook?.worksheets.reduce((sum, worksheet) => sum + worksheet.rows.length, 0) ?? 0,
    [workbook],
  );
  const maxColumns = useMemo(
    () => workbook?.worksheets.reduce((maximum, worksheet) => Math.max(maximum, worksheet.maxColumn), 0) ?? 0,
    [workbook],
  );

  const handleDownload = () => {
    if (!workbook) return;
    setDownloadState("working");
    try {
      const filename = reportFilename();
      const blob = new Blob([buildCombinedCsv(workbook)], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.setAttribute("data-testid", "download-link");
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDownloadState("success");
      toast({
        title: "CSV ready",
        description: `${filename} contains all three worksheets in source order.`,
      });
    } catch (error) {
      console.error("Customer CSV generation failed", error);
      setDownloadState("error");
      toast({
        title: "Download failed",
        description: "The combined CSV could not be generated. Try again.",
        variant: "destructive",
      });
    }
  };

  const downloadStatus =
    downloadState === "working"
      ? "Preparing the combined CSV…"
      : downloadState === "success"
        ? "Download started. The workbook is unchanged."
        : downloadState === "error"
          ? "Download failed. Try again."
          : "Ready to download";

  return (
    <main className="min-h-screen bg-background">
      <div className="report-shell">
        <header className="report-header">
          <div className="flex items-start gap-4">
            <div className="report-mark" aria-hidden="true">
              <FileSpreadsheet className="h-6 w-6" />
            </div>
            <div>
              <p className="eyebrow">Standalone source report</p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl" data-testid="text-report-title">
                Customer workbook preview
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                A read-only view of the supplied report, kept separate from Vivo BI and Vivo CRM.
              </p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3 lg:mt-0 lg:justify-end">
            <div className="source-chip" data-testid="text-source-file">
              <span className="source-chip-label">Source</span>
              <span className="font-mono">{workbook?.sourceFile ?? "Loading workbook…"}</span>
            </div>
            <Button
              variant="outline"
              onClick={loadWorkbook}
              disabled={loadState === "loading"}
              data-testid="button-refresh"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${loadState === "loading" ? "animate-spin" : ""}`} />
              Reload
            </Button>
            <Button
              onClick={handleDownload}
              disabled={loadState !== "ready" || downloadState === "working"}
              data-testid="button-download-csv"
            >
              {downloadState === "working" ? (
                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              Download combined CSV
            </Button>
          </div>
        </header>

        {loadState === "ready" && workbook ? (
          <>
            <section className="report-meta" aria-label="Report summary">
              <div>
                <span className="meta-label">Worksheets</span>
                <strong data-testid="text-worksheet-count">{workbook.worksheets.length}</strong>
              </div>
              <div>
                <span className="meta-label">Source rows</span>
                <strong data-testid="text-row-count">{totalRows.toLocaleString()}</strong>
              </div>
              <div>
                <span className="meta-label">Union columns</span>
                <strong data-testid="text-column-count">{maxColumns}</strong>
              </div>
              <div className="meta-note">
                <Info className="h-4 w-4 shrink-0" />
                <span>Blank cells and original row positions are included in the export.</span>
              </div>
            </section>

            <section className="mt-8" aria-label="Workbook worksheets">
              <div className="worksheet-tabs" role="tablist" aria-label="Source worksheets">
                {workbook.worksheets.map((worksheet, index) => (
                  <button
                    key={worksheet.name}
                    type="button"
                    role="tab"
                    aria-selected={activeSheet === index}
                    className={`worksheet-tab ${activeSheet === index ? "is-active" : ""}`}
                    onClick={() => setActiveSheet(index)}
                    data-testid={`tab-${sheetId(worksheet.name)}`}
                  >
                    <span>{worksheet.name}</span>
                    <span className="tab-count">{worksheet.rows.length.toLocaleString()}</span>
                  </button>
                ))}
              </div>
              <div className="mt-4">
                <WorksheetPreview worksheet={workbook.worksheets[activeSheet]} />
              </div>
            </section>

            <div className="download-status" data-testid="status-download" aria-live="polite">
              {downloadState === "success" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : downloadState === "error" ? (
                <AlertCircle className="h-4 w-4 text-destructive" />
              ) : (
                <Download className="h-4 w-4 text-muted-foreground" />
              )}
              <span>{downloadStatus}</span>
            </div>
          </>
        ) : loadState === "loading" ? (
          <LoadingState />
        ) : (
          <StatusMessage
            kind={loadState === "error" ? "error" : "empty"}
            onRetry={loadWorkbook}
          />
        )}

        <footer className="report-footer">
          <span>Read-only fixture · no production customer data connection</span>
          <span>UTF-8 CSV · Excel-friendly</span>
        </footer>
      </div>
    </main>
  );
}
