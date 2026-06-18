import React, { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RefreshCcw, SmilePlus } from "lucide-react";

const errOf = (e) =>
  e?.response?.data?.detail || e?.message || "Something went wrong";

const titleCase = (s) =>
  (s || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

const fmtPct = (n) =>
  n === null || n === undefined ? "—" : `${(Number(n) * 100).toFixed(0)}%`;
const fmtNum = (n) => Number(n || 0).toLocaleString();
const fmtScore = (n) =>
  n === null || n === undefined ? "—" : Number(n).toFixed(2);

const SCORE_COLORS = {
  5: "#0F4D31",
  4: "#3F8F5E",
  3: "#ED7C2A",
  2: "#E2592B",
  1: "#DC2626",
};

function Kpi({ label, value, sub }) {
  return (
    <Card className="vivo-card rounded-sm p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">
        {label}
      </div>
      <div className="mt-1 font-display text-3xl text-[var(--vivo-navy)]">
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-[12px] text-[var(--vivo-muted)]">{sub}</div>
      )}
    </Card>
  );
}

function MiniTable({ title, columns, rows, render, empty }) {
  return (
    <Card className="vivo-card rounded-sm p-0">
      <div className="border-b border-[var(--vivo-border)] px-4 py-3 text-[13px] font-semibold text-[var(--vivo-text)]">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="py-8 text-center text-[12px] text-[var(--vivo-muted)]">
          {empty || "No data."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--vivo-border)] text-left text-[11px] uppercase tracking-wide text-[var(--vivo-muted)]">
                {columns.map((c, i) => (
                  <th
                    key={c}
                    className={`px-4 py-2 font-semibold ${i > 0 ? "text-right" : ""}`}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{rows.map(render)}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function CSAT() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = dateFrom && dateTo ? { date_from: dateFrom, date_to: dateTo } : {};
    api
      .get("/crm/csat/dashboard", { params })
      .then((r) => setData(r.data))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  const summary = data?.summary;
  const dist = summary?.distribution || {};
  const maxDist = Math.max(1, ...Object.values(dist).map((v) => Number(v) || 0));

  return (
    <div className="px-4 py-5 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <SmilePlus className="h-5 w-5 text-[var(--vivo-navy)]" />
          <h1 className="font-display text-2xl text-[var(--vivo-navy)]">
            CSAT
          </h1>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-9 w-36 rounded-sm border border-[var(--vivo-border)] text-xs"
          />
          <span className="text-[var(--vivo-muted)]">→</span>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-9 w-36 rounded-sm border border-[var(--vivo-border)] text-xs"
          />
          {[
            {
              label: "Last 30d",
              fn: () => {
                const d = new Date();
                const f = new Date();
                f.setDate(f.getDate() - 30);
                setDateFrom(f.toISOString().slice(0, 10));
                setDateTo(d.toISOString().slice(0, 10));
              },
            },
            {
              label: "Last 90d",
              fn: () => {
                const d = new Date();
                const f = new Date();
                f.setDate(f.getDate() - 90);
                setDateFrom(f.toISOString().slice(0, 10));
                setDateTo(d.toISOString().slice(0, 10));
              },
            },
            { label: "All time", fn: () => { setDateFrom(""); setDateTo(""); } },
          ].map((p) => (
            <button
              key={p.label}
              onClick={p.fn}
              className="h-8 rounded-sm border border-[var(--vivo-border)] px-2.5 text-[10px] uppercase tracking-wider press-effect hover:bg-[var(--vivo-bg-soft)]"
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={load}
            className="inline-flex h-9 items-center gap-2 rounded-sm border border-[var(--vivo-border)] px-3 text-sm press-effect hover:bg-[var(--vivo-bg-soft)]"
          >
            <RefreshCcw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-[var(--vivo-muted)]">
          Loading CSAT…
        </div>
      ) : error ? (
        <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Kpi label="Surveys requested" value={fmtNum(summary?.requested)} />
            <Kpi label="Responses" value={fmtNum(summary?.responses)} />
            <Kpi
              label="Response rate"
              value={fmtPct(summary?.response_rate)}
              sub="of deliverable surveys"
            />
            <Kpi
              label="Avg score"
              value={fmtScore(summary?.avg_score)}
              sub="out of 5"
            />
            <Kpi label="Skipped" value={fmtNum(summary?.skipped)} sub="not deliverable" />
          </div>

          {/* Score distribution */}
          <Card className="vivo-card rounded-sm p-4">
            <div className="mb-3 text-[13px] font-semibold text-[var(--vivo-text)]">
              Score distribution
            </div>
            <div className="space-y-2">
              {[5, 4, 3, 2, 1].map((n) => {
                const v = Number(dist[String(n)] || 0);
                const pct = Math.round((v / maxDist) * 100);
                return (
                  <div key={n} className="flex items-center gap-3">
                    <div className="w-6 text-right text-[12px] font-semibold text-[var(--vivo-muted)]">
                      {n}
                    </div>
                    <div className="h-4 flex-1 overflow-hidden rounded-sm bg-[var(--vivo-bg)]">
                      <div
                        className="h-full rounded-sm"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: SCORE_COLORS[n],
                        }}
                      />
                    </div>
                    <div className="w-12 text-right text-[12px] text-[var(--vivo-text)]">
                      {fmtNum(v)}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <MiniTable
              title="By survey type"
              columns={["Type", "Requested", "Responses", "Avg"]}
              rows={data?.by_type || []}
              empty="No surveys yet."
              render={(r) => (
                <tr
                  key={r.survey_type}
                  className="border-b border-[var(--vivo-border)]/60"
                >
                  <td className="px-4 py-2">{titleCase(r.survey_type)}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(r.requested)}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(r.responses)}</td>
                  <td className="px-4 py-2 text-right font-semibold text-[var(--vivo-navy)]">
                    {fmtScore(r.avg_score)}
                  </td>
                </tr>
              )}
            />
            <MiniTable
              title="By channel"
              columns={["Channel", "Responses", "Avg"]}
              rows={data?.by_channel || []}
              empty="No responses yet."
              render={(r) => (
                <tr
                  key={r.channel}
                  className="border-b border-[var(--vivo-border)]/60"
                >
                  <td className="px-4 py-2">{titleCase(r.channel)}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(r.responses)}</td>
                  <td className="px-4 py-2 text-right font-semibold text-[var(--vivo-navy)]">
                    {fmtScore(r.avg_score)}
                  </td>
                </tr>
              )}
            />
            <MiniTable
              title="By store"
              columns={["Store", "Responses", "Avg"]}
              rows={data?.by_store || []}
              empty="No store-tagged responses yet."
              render={(r) => (
                <tr key={r.store} className="border-b border-[var(--vivo-border)]/60">
                  <td className="px-4 py-2">{r.store}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(r.responses)}</td>
                  <td className="px-4 py-2 text-right font-semibold text-[var(--vivo-navy)]">
                    {fmtScore(r.avg_score)}
                  </td>
                </tr>
              )}
            />
            <MiniTable
              title="Weekly trend"
              columns={["Week", "Requested", "Responses", "Avg"]}
              rows={data?.trend || []}
              empty="No trend yet."
              render={(r) => (
                <tr key={r.week} className="border-b border-[var(--vivo-border)]/60">
                  <td className="px-4 py-2">{r.week}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(r.requested)}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(r.responses)}</td>
                  <td className="px-4 py-2 text-right font-semibold text-[var(--vivo-navy)]">
                    {fmtScore(r.avg_score)}
                  </td>
                </tr>
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}
