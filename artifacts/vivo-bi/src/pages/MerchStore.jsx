/**
 * MerchStore — Store Detail tab
 * ?tab=merch-store
 *
 * Data: /api/merch/by-store (aggregated per-store KPIs from all styles)
 * Charts: Revenue by store bar, Stock by store bar, Store performance scatter
 *         (WOC vs SOR), Store detail table sorted by revenue
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, ScatterChart, Scatter, ZAxis, LabelList, Legend,
} from "recharts";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import { apiFetch, fmtKES, fmtNum, fmtDec } from "@/lib/api";
import { useMerchFilters } from "./MerchandisingHub";

// ── Colour helpers ─────────────────────────────────────────────────────────────
const WOC_COLOR = (woc) => {
  if (woc === null || woc === undefined) return "#94a3b8";
  if (woc < 4)  return "#ef4444";
  if (woc <= 8) return "#d97706";
  return "#1a5c38";
};

const TIER_BADGE = { A: "#1a5c38", B: "#4b7bec", C: "#94a3b8" };

const SCATTER_COLORS = ["#1a5c38", "#4b7bec", "#d97706", "#0891b2", "#7c3aed",
  "#be185d", "#065f46", "#ef4444", "#9f1239", "#1e40af"];

const truncate = (s, n = 24) => s && s.length > n ? s.slice(0, n - 1) + "…" : (s || "—");

const ScatterTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-white border border-border rounded-lg shadow-lg p-3 text-[12px] min-w-[180px]">
      <p className="font-bold text-foreground mb-1">{d.store}</p>
      <p className="text-muted">Avg WOC: <span className="font-medium text-foreground">{d.avg_woc !== null ? fmtDec(d.avg_woc, 1) + " wks" : "—"}</span></p>
      <p className="text-muted">Avg SOR: <span className="font-medium text-foreground">{d.avg_sor !== null ? fmtDec(d.avg_sor, 1) + "%" : "—"}</span></p>
      <p className="text-muted">Revenue 6m: <span className="font-medium text-foreground">{fmtKES(d.revenue_6m || 0)}</span></p>
      <p className="text-muted">Style count: <span className="font-medium text-foreground">{fmtNum(d.style_count || 0)}</span></p>
    </div>
  );
};

const MerchStore = () => {
  const filters = useMerchFilters();
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = { country: filters.country, from_date: filters.from_date, to_date: filters.to_date };
    apiFetch("/merch/by-store", { params })
      .then(d => { if (!cancelled) setRows(d.rows || []); })
      .catch(e => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters.country, filters.from_date, filters.to_date, filters.dataVersion]);

  // ── KPI derivations ───────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const totalRev   = rows.reduce((s, r) => s + (r.revenue_6m || 0), 0);
    const totalStock = rows.reduce((s, r) => s + (r.total_stock || 0), 0);
    const wocRows    = rows.filter(r => r.avg_woc !== null);
    const avgWoc     = wocRows.length ? wocRows.reduce((s, r) => s + r.avg_woc, 0) / wocRows.length : null;
    const sorRows    = rows.filter(r => r.avg_sor !== null);
    const avgSor     = sorRows.length ? sorRows.reduce((s, r) => s + r.avg_sor, 0) / sorRows.length : null;
    const lowWoc     = rows.filter(r => r.avg_woc !== null && r.avg_woc < 4).length;
    return { storeCount: rows.length, totalRev, totalStock, avgWoc, avgSor, lowWoc };
  }, [rows]);

  // ── Revenue bar — top 15 ──────────────────────────────────────────────────
  const revBars = useMemo(() =>
    rows
      .sort((a, b) => (b.revenue_6m || 0) - (a.revenue_6m || 0))
      .slice(0, 15)
      .map(r => ({
        name: truncate(r.store, 22),
        rev:  Math.round((r.revenue_6m || 0) / 1000),
        fill: TIER_BADGE[r.store_tier] || "#94a3b8",
      }))
  , [rows]);

  // ── Stock bar — top 15 ────────────────────────────────────────────────────
  const stockBars = useMemo(() =>
    rows
      .sort((a, b) => (b.total_stock || 0) - (a.total_stock || 0))
      .slice(0, 15)
      .map(r => ({
        name:  truncate(r.store, 22),
        stock: r.total_stock || 0,
        fill:  WOC_COLOR(r.avg_woc),
      }))
  , [rows]);

  // ── Scatter — WOC vs SOR ──────────────────────────────────────────────────
  const scatterData = useMemo(() =>
    rows
      .filter(r => r.avg_woc !== null && r.avg_sor !== null)
      .map((r, i) => ({
        store:     r.store,
        avg_woc:   Math.round(r.avg_woc * 10) / 10,
        avg_sor:   Math.round(r.avg_sor * 10) / 10,
        revenue_6m: r.revenue_6m || 0,
        style_count: r.style_count || 0,
        z:         Math.max(50, Math.min(800, (r.revenue_6m || 0) / 5000)),
        fill:      SCATTER_COLORS[i % SCATTER_COLORS.length],
      }))
  , [rows]);

  if (loading) return <Loading label="Loading store data…" />;
  if (error)   return <ErrorBox message={error} />;

  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h2 className="text-[22px] font-bold text-foreground">Store Detail</h2>
        <p className="text-[13px] text-muted mt-0.5">Store-level stock, sell-through &amp; performance · 6-month window · As at {today}</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KPICard label="Active Stores"   value={fmtNum(kpis.storeCount)}                                            sub="With sales or stock"   showDelta={false} />
        <KPICard label="Total Revenue"   value={fmtKES(kpis.totalRev)}                                              sub="Net ex-VAT, 6m"        showDelta={false} />
        <KPICard label="Total Stock"     value={fmtNum(kpis.totalStock)}                                            sub="Current store units"   showDelta={false} />
        <KPICard
          label="Avg WOC"
          value={kpis.avgWoc !== null ? `${fmtDec(kpis.avgWoc, 1)} wks` : "—"}
          sub="Weeks of cover"
          showDelta={false}
          accent={kpis.avgWoc !== null && kpis.avgWoc < 4}
        />
        <KPICard label="Stores Low Stock" value={fmtNum(kpis.lowWoc)} sub="Avg WOC < 4 weeks" showDelta={false} accent={kpis.lowWoc > 0} />
      </div>

      {/* Revenue bar + Stock bar */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card-white p-5">
          <SectionTitle title="Revenue by Store — Top 15" subtitle="KES '000 · 6-month net · colour = store tier (A/B/C)" />
          <div className="mt-3" style={{ height: 360 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revBars} layout="vertical" margin={{ left: 8, right: 60, top: 4, bottom: 4 }}>
                <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `${fmtNum(v)}k`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={155} />
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                <Tooltip formatter={(v) => [`KES ${fmtNum(v)}k`, "Revenue"]} />
                <Bar dataKey="rev" radius={[0, 3, 3, 0]}>
                  {revBars.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="rev" position="right" formatter={v => `${fmtNum(v)}k`} style={{ fontSize: 9, fill: "#64748b" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-2 text-[10.5px] text-muted flex-wrap">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#1a5c38]" /> Tier A</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#4b7bec]" /> Tier B</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#94a3b8]" /> Tier C</span>
          </div>
        </div>

        <div className="card-white p-5">
          <SectionTitle title="Stock by Store — Top 15" subtitle="Current units · colour = avg WOC health" />
          <div className="mt-3" style={{ height: 360 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stockBars} layout="vertical" margin={{ left: 8, right: 60, top: 4, bottom: 4 }}>
                <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => fmtNum(v)} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={155} />
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                <Tooltip formatter={(v) => [fmtNum(v) + " units", "Stock"]} />
                <Bar dataKey="stock" radius={[0, 3, 3, 0]}>
                  {stockBars.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="stock" position="right" formatter={v => fmtNum(v)} style={{ fontSize: 9, fill: "#64748b" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-2 text-[10.5px] text-muted flex-wrap">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#ef4444]" /> WOC &lt;4 (restock)</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#d97706]" /> WOC 4–8</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#1a5c38]" /> WOC &gt;8</span>
          </div>
        </div>
      </div>

      {/* WOC vs SOR scatter */}
      {scatterData.length > 0 && (
        <div className="card-white p-5">
          <SectionTitle title="Store Efficiency — Avg WOC vs Avg SOR" subtitle="Bubble size = revenue · ideal = high SOR, moderate WOC" />
          <div className="mt-3" style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, left: -10, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis type="number" dataKey="avg_woc" name="Avg WOC" tick={{ fontSize: 10 }}
                  label={{ value: "Avg WOC (wks)", position: "insideBottom", offset: -5, fontSize: 10 }} />
                <YAxis type="number" dataKey="avg_sor" name="Avg SOR %" tick={{ fontSize: 10 }}
                  label={{ value: "Avg SOR %", angle: -90, position: "insideLeft", offset: 14, fontSize: 9 }} />
                <ZAxis type="number" dataKey="z" range={[40, 600]} />
                <Tooltip content={<ScatterTooltip />} />
                <Scatter data={scatterData} fill="#1a5c38">
                  {scatterData.map((d, i) => <Cell key={i} fill={d.fill} fillOpacity={0.75} />)}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Store detail table */}
      <div className="card-white p-5">
        <SectionTitle title="All Stores — Performance Summary" subtitle="Sorted by 6-month revenue" />
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border text-muted uppercase text-[10px] tracking-wider">
                <th className="text-left pb-2 pr-3">Store</th>
                <th className="text-right pb-2 pr-3">Tier</th>
                <th className="text-right pb-2 pr-3">Styles</th>
                <th className="text-right pb-2 pr-3">Units 6m</th>
                <th className="text-right pb-2 pr-3">Revenue 6m</th>
                <th className="text-right pb-2 pr-3">Stock</th>
                <th className="text-right pb-2 pr-3">Avg WOC</th>
                <th className="text-right pb-2">Avg SOR</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .sort((a, b) => (b.revenue_6m || 0) - (a.revenue_6m || 0))
                .map((r, i) => {
                  const wocColor = WOC_COLOR(r.avg_woc);
                  const tierColor = TIER_BADGE[r.store_tier] || "#94a3b8";
                  return (
                    <tr key={i} className="border-b border-border/40 hover:bg-surface/50">
                      <td className="py-1.5 pr-3 font-medium text-foreground">{r.store}</td>
                      <td className="py-1.5 pr-3 text-right">
                        <span
                          className="px-1.5 py-0.5 rounded text-[11px] font-bold"
                          style={{ background: tierColor + "20", color: tierColor }}
                        >{r.store_tier || "—"}</span>
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(r.style_count || 0)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(r.units_6m || 0)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtKES(r.revenue_6m || 0)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(r.total_stock || 0)}</td>
                      <td className="py-1.5 pr-3 text-right">
                        {r.avg_woc !== null ? (
                          <span
                            className="px-1.5 py-0.5 rounded text-[11px] font-semibold"
                            style={{ background: wocColor + "20", color: wocColor }}
                          >
                            {fmtDec(r.avg_woc, 1)} wks
                          </span>
                        ) : "—"}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {r.avg_sor !== null ? `${fmtDec(r.avg_sor, 1)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              {rows.length === 0 && (
                <tr><td colSpan={8} className="py-6 text-center text-muted text-[13px]">No store data available for current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default MerchStore;
