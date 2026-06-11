import { useState } from "react";
import { STORES, NETWORK, ACCENT, fmtKES, fmtPct, type StoreRow } from "./data";

const W = 940, H = 720;
const M = { t: 28, r: 28, b: 66, l: 96 };
const IW = W - M.l - M.r;
const IH = H - M.t - M.b;
const X_MAX = 22;
const Y_MIN = 3500, Y_MAX = 14000;

const xScale = (c: number) => M.l + (c / X_MAX) * IW;
const yScale = (a: number) => M.t + (1 - (a - Y_MIN) / (Y_MAX - Y_MIN)) * IH;
const rScale = (o: number) => {
  const r = 7 + ((Math.min(o, 1000) - 100) / 900) * 19;
  return Math.max(7, Math.min(26, r));
};

const netX = xScale(NETWORK.netConv);
const netY = yScale(NETWORK.netAbv);

const plotted = STORES.filter((s) => s.convReliable && s.conversion != null);
const notPlotted = STORES.filter((s) => !s.convReliable);

export function Quadrant() {
  const [hover, setHover] = useState<StoreRow | null>(null);

  return (
    <div className="min-h-screen w-full" style={{ background: "#f7efe7", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div className="mx-auto max-w-[980px] px-7 py-7">
        <div className="rounded-2xl bg-white shadow-sm border border-black/5 overflow-hidden">
          <div className="px-7 pt-6 pb-4 border-b border-black/5">
            <div className="text-[11px] font-semibold tracking-[0.14em] uppercase" style={{ color: "#1a5c38" }}>
              Diagnosis
            </div>
            <h2 className="mt-1 text-[22px] font-semibold tracking-tight text-neutral-900">
              Conversion vs. Average Basket
            </h2>
            <p className="mt-1 text-[13px] text-neutral-500 leading-relaxed max-w-[640px]">
              Each store positioned against the network average. Where a store sits tells you the <em>kind</em> of
              problem it has — not just whether it is good or bad. Bubble size = orders. {NETWORK.window}.
            </p>
          </div>

          <div className="relative">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full block">
              {/* quadrant tints */}
              <rect x={netX} y={M.t} width={M.l + IW - netX} height={netY - M.t} fill="#1a5c38" opacity={0.05} />
              <rect x={M.l} y={M.t} width={netX - M.l} height={netY - M.t} fill="#d97706" opacity={0.04} />
              <rect x={netX} y={netY} width={M.l + IW - netX} height={M.t + IH - netY} fill="#4b7bec" opacity={0.04} />
              <rect x={M.l} y={netY} width={netX - M.l} height={M.t + IH - netY} fill="#b91c1c" opacity={0.04} />

              {/* gridlines */}
              {[5, 10, 15, 20].map((c) => (
                <line key={c} x1={xScale(c)} y1={M.t} x2={xScale(c)} y2={M.t + IH} stroke="#000" opacity={0.04} />
              ))}
              {[5000, 7500, 10000, 12500].map((a) => (
                <line key={a} x1={M.l} y1={yScale(a)} x2={M.l + IW} y2={yScale(a)} stroke="#000" opacity={0.04} />
              ))}

              {/* network crosshairs */}
              <line x1={netX} y1={M.t} x2={netX} y2={M.t + IH} stroke="#1a5c38" strokeDasharray="5 4" strokeWidth={1.4} opacity={0.55} />
              <line x1={M.l} y1={netY} x2={M.l + IW} y2={netY} stroke="#1a5c38" strokeDasharray="5 4" strokeWidth={1.4} opacity={0.55} />

              {/* quadrant labels */}
              <text x={M.l + IW - 8} y={M.t + 18} textAnchor="end" className="fill-neutral-400" style={{ fontSize: 11, fontWeight: 600 }}>WIN ZONE — both levers healthy</text>
              <text x={M.l + 8} y={M.t + 18} textAnchor="start" className="fill-neutral-400" style={{ fontSize: 11, fontWeight: 600 }}>Premium basket, low conversion</text>
              <text x={M.l + IW - 8} y={M.t + IH - 10} textAnchor="end" className="fill-neutral-400" style={{ fontSize: 11, fontWeight: 600 }}>High conversion, small basket</text>
              <text x={M.l + 8} y={M.t + IH - 10} textAnchor="start" className="fill-neutral-400" style={{ fontSize: 11, fontWeight: 600 }}>Underperforming</text>

              {/* axes */}
              <line x1={M.l} y1={M.t + IH} x2={M.l + IW} y2={M.t + IH} stroke="#000" opacity={0.18} />
              <line x1={M.l} y1={M.t} x2={M.l} y2={M.t + IH} stroke="#000" opacity={0.18} />
              {[0, 5, 10, 15, 20].map((c) => (
                <text key={c} x={xScale(c)} y={M.t + IH + 20} textAnchor="middle" className="fill-neutral-500" style={{ fontSize: 11 }}>{c}%</text>
              ))}
              {[5000, 7500, 10000, 12500].map((a) => (
                <text key={a} x={M.l - 10} y={yScale(a) + 4} textAnchor="end" className="fill-neutral-500" style={{ fontSize: 11 }}>{(a / 1000).toFixed(0)}k</text>
              ))}
              <text x={M.l + IW / 2} y={H - 14} textAnchor="middle" className="fill-neutral-600" style={{ fontSize: 12, fontWeight: 600 }}>Conversion rate</text>
              <text transform={`rotate(-90 18 ${M.t + IH / 2})`} x={18} y={M.t + IH / 2} textAnchor="middle" className="fill-neutral-600" style={{ fontSize: 12, fontWeight: 600 }}>Average basket (KES)</text>
              <text x={netX} y={M.t - 6} textAnchor="middle" style={{ fontSize: 10.5, fontWeight: 700, fill: "#1a5c38" }}>avg {NETWORK.netConv}%</text>

              {/* bubbles */}
              {plotted.map((s) => {
                const cx = xScale(s.conversion as number);
                const cy = yScale(s.abv);
                const r = rScale(s.orders);
                const c = ACCENT[s.country] ?? "#777";
                const active = hover?.store === s.store;
                return (
                  <g key={s.store} onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover(null)} style={{ cursor: "pointer" }}>
                    <circle cx={cx} cy={cy} r={r} fill={c} fillOpacity={active ? 0.42 : 0.24} stroke={c} strokeWidth={active ? 2.4 : 1.5} />
                    {(r >= 14 || active) && (
                      <text x={cx} y={cy + 3.5} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600, fill: "#1f2937" }}>{s.store}</text>
                    )}
                  </g>
                );
              })}
            </svg>

            {/* hover detail card */}
            <div className="absolute top-4 right-4 w-[210px] rounded-xl border border-black/5 bg-white/95 backdrop-blur shadow-sm px-4 py-3 pointer-events-none">
              {hover ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: ACCENT[hover.country] }} />
                    <span className="text-[13px] font-semibold text-neutral-900">{hover.store}</span>
                  </div>
                  <div className="mt-2.5 space-y-1.5 text-[12px]">
                    <Row k="Conversion" v={fmtPct(hover.conversion)} />
                    <Row k="Avg basket" v={fmtKES(hover.abv)} />
                    <Row k="Orders" v={hover.orders.toLocaleString()} />
                    <Row k="Net sales" v={fmtKES(hover.sales)} />
                    <Row k="Footfall" v={hover.footfall.toLocaleString()} />
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-neutral-400 leading-relaxed">Hover any bubble for the full numbers.</div>
              )}
            </div>
          </div>

          {/* legend + excluded */}
          <div className="px-7 py-4 border-t border-black/5 flex flex-wrap items-center gap-x-6 gap-y-2">
            {Object.entries(ACCENT).map(([k, v]) => (
              <div key={k} className="flex items-center gap-1.5 text-[12px] text-neutral-600">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: v }} />{k}
              </div>
            ))}
            <div className="flex items-center gap-1.5 text-[12px] text-neutral-500">
              <span className="inline-block w-4 h-4 rounded-full border" style={{ borderColor: "#1a5c38" }} />
              <span className="inline-block w-2.5 h-2.5 rounded-full border" style={{ borderColor: "#1a5c38" }} />
              bubble = orders
            </div>
          </div>
          {notPlotted.length > 0 && (
            <div className="px-7 pb-5 -mt-1">
              <div className="rounded-lg bg-neutral-50 border border-black/5 px-4 py-2.5 text-[12px] text-neutral-500">
                <span className="font-semibold text-neutral-600">Not plotted (no reliable footfall):</span>{" "}
                {notPlotted.map((s, i) => (
                  <span key={s.store}>
                    {s.store}
                    {s.noFootfall ? " (online channel)" : ` (sensor down ${s.sensorGap}/30 days)`}
                    {i < notPlotted.length - 1 ? " · " : ""}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-neutral-400">{k}</span>
      <span className="font-semibold text-neutral-800 tabular-nums">{v}</span>
    </div>
  );
}
