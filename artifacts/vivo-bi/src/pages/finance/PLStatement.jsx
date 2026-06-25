import React, { useMemo, useState } from "react";
import { CaretRight, CaretDown } from "@phosphor-icons/react";
import { SectionTitle } from "@/components/common";
import { exportCSV } from "@/components/SortableTable";
import {
  STATEMENT,
  Money,
  HonestyTags,
  usePlDetail,
  monthLabel,
  monthLabelLong,
  sumKey,
  num,
} from "./shared";

// Flagship report: the official Odoo Profit & Loss statement.
//   • Single-period mode — one amount column (summed over the window); group
//     rows (Revenue / each cost & opex group / Other Income) expand to their
//     constituent accounts via GET /api/finance/pl-detail.
//   • Monthly-columns mode — months as columns, each line item a row; column
//     headers flag anomaly / not-closed months.
export default function PLStatement({ months, fromMonth, toMonth, periodLabel }) {
  const [mode, setMode] = useState("single");
  const [expanded, setExpanded] = useState({});

  // Account-level detail for the selected window (drives the drill-downs).
  const { detail, loading: detailLoading } = usePlDetail(fromMonth, toMonth);

  // Single-period summed value per statement key.
  const single = useMemo(() => {
    const o = {};
    STATEMENT.forEach((r) => {
      if (r.key) o[r.key] = sumKey(months, r.key);
    });
    return o;
  }, [months]);

  // Accounts under a drill spec (section or pl_group), descending by amount.
  const accountsFor = (drill) => {
    if (!drill) return [];
    return detail
      .filter((d) => (drill.section ? d.pl_section === drill.section : d.pl_group === drill.group))
      .slice()
      .sort((a, b) => num(b.amount) - num(a.amount));
  };

  const toggle = (key) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  const exportSingle = () => {
    const cols = [
      { key: "line", label: "Line Item" },
      { key: "amount", label: "Amount (KES)", csv: (r) => (r.amount === "" ? "" : String(r.amount)) },
    ];
    const rows = [];
    STATEMENT.forEach((r) => {
      if (r.kind === "section") {
        rows.push({ line: r.label, amount: "" });
        return;
      }
      rows.push({ line: r.label, amount: num(single[r.key]) });
    });
    exportCSV(rows, cols, "finance-pl-statement.csv");
  };

  const exportMonthly = () => {
    const cols = [
      { key: "line", label: "Line Item" },
      ...months.map((m) => ({
        key: m.month,
        label: `${monthLabel(m.month)}${m.is_closed ? "" : " (open)"}${m.has_cost_anomaly ? " (anomaly)" : ""}`,
        csv: (r) => (r[m.month] === "" ? "" : String(r[m.month])),
      })),
    ];
    const rows = STATEMENT.filter((r) => r.kind !== "section").map((r) => {
      const row = { line: r.label };
      months.forEach((m) => (row[m.month] = num(m[r.key])));
      return row;
    });
    exportCSV(rows, cols, "finance-pl-monthly.csv");
  };

  return (
    <div className="space-y-4" data-testid="finance-pl-statement">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 rounded-lg border border-border bg-panel/40 p-0.5">
          {[
            { k: "single", l: "Single period" },
            { k: "monthly", l: "Monthly columns" },
          ].map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => setMode(t.k)}
              data-testid={`pl-mode-${t.k}`}
              className={`text-[12px] font-semibold px-3 py-1.5 rounded-md transition-colors ${
                mode === t.k ? "bg-brand text-white" : "text-muted hover:text-foreground"
              }`}
            >
              {t.l}
            </button>
          ))}
        </div>
        <HonestyTags rows={months} />
      </div>

      <div className="card-white p-4">
        <SectionTitle
          title="Profit &amp; Loss Statement"
          subtitle={`Official Odoo P&L structure, in KES · ${periodLabel}${
            mode === "single" ? " · click a line to see its accounts" : ""
          }`}
          action={
            <button
              type="button"
              onClick={mode === "single" ? exportSingle : exportMonthly}
              className="inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-brand px-2 py-1 rounded border border-border hover:border-brand"
              data-testid="pl-export"
            >
              Export CSV
            </button>
          }
        />

        {months.length === 0 ? (
          <p className="text-[12.5px] text-muted py-6 text-center">No P&L data for the selected period.</p>
        ) : mode === "single" ? (
          <div className="overflow-auto" style={{ maxHeight: "70vh" }}>
            <table className="w-full data">
              <thead>
                <tr>
                  <th className="text-left">Line Item</th>
                  <th className="text-right">{monthLabelLong(fromMonth)} – {monthLabelLong(toMonth)}</th>
                </tr>
              </thead>
              <tbody>
                {STATEMENT.map((r, i) => {
                  if (r.kind === "section") {
                    return (
                      <tr key={`s${i}`} className="bg-panel/50">
                        <td colSpan={2} className="text-[11px] font-bold uppercase tracking-wider text-muted pt-3">
                          {r.label}
                        </td>
                      </tr>
                    );
                  }
                  const isTotal = r.kind === "total";
                  const isSub = r.kind === "subtotal";
                  const accounts = r.drill ? accountsFor(r.drill) : [];
                  const canDrill = r.drill && accounts.length > 0;
                  const open = expanded[r.key];
                  return (
                    <React.Fragment key={r.key}>
                      <tr
                        className={`${isTotal ? "border-t-2 border-border font-bold" : isSub ? "border-t border-border font-semibold" : ""} ${
                          canDrill ? "cursor-pointer hover:bg-panel/40" : ""
                        }`}
                        onClick={canDrill ? () => toggle(r.key) : undefined}
                      >
                        <td className={`${r.kind === "line" ? "pl-4" : ""} ${r.big ? "text-[14px]" : ""}`}>
                          <span className="inline-flex items-center gap-1.5">
                            {canDrill &&
                              (open ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />)}
                            {r.label}
                            {r.drill && !canDrill && !detailLoading && (
                              <span className="text-[10px] text-muted">(no detail)</span>
                            )}
                          </span>
                        </td>
                        <td className="text-right">
                          <Money value={single[r.key]} strong={isTotal || isSub} className={r.big ? "text-[14px]" : ""} />
                        </td>
                      </tr>
                      {open &&
                        accounts.map((a) => (
                          <tr key={`${r.key}-${a.account_code}`} className="bg-panel/20 text-[12px]">
                            <td className="pl-9 text-muted">
                              <span className="text-[10.5px] text-muted/70 mr-1.5">{a.account_code}</span>
                              {a.account_name}
                            </td>
                            <td className="text-right">
                              <Money value={a.amount} muted />
                            </td>
                          </tr>
                        ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-auto" style={{ maxHeight: "70vh" }}>
            <table className="w-full data sticky-first-col">
              <thead>
                <tr>
                  <th className="text-left">Line Item</th>
                  {months.map((m) => (
                    <th key={m.month} className="text-right">
                      <div className="flex flex-col items-end gap-0.5">
                        <span>{monthLabel(m.month)}</span>
                        <span className="inline-flex gap-1">
                          {m.has_cost_anomaly && <span title="Cost anomaly under review" className="text-red-600">⚠</span>}
                          {!m.is_closed && (
                            <span title="Month not closed — partial" className="text-[9px] text-amber-600 font-bold uppercase">
                              open
                            </span>
                          )}
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {STATEMENT.map((r, i) => {
                  if (r.kind === "section") {
                    return (
                      <tr key={`s${i}`} className="bg-panel/50">
                        <td colSpan={months.length + 1} className="text-[11px] font-bold uppercase tracking-wider text-muted pt-3">
                          {r.label}
                        </td>
                      </tr>
                    );
                  }
                  const isTotal = r.kind === "total";
                  const isSub = r.kind === "subtotal";
                  return (
                    <tr
                      key={r.key}
                      className={`${isTotal ? "border-t-2 border-border font-bold" : isSub ? "border-t border-border font-semibold" : ""}`}
                    >
                      <td className={r.kind === "line" ? "pl-4" : ""}>{r.label}</td>
                      {months.map((m) => (
                        <td key={m.month} className="text-right">
                          <Money value={m[r.key]} strong={isTotal || isSub} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-muted mt-3">
          Operating Income = Gross Profit − Total Operating Expenses. Net Profit = Operating Income + Other Income. Losses
          are shown in red parentheses.
        </p>
      </div>
    </div>
  );
}
