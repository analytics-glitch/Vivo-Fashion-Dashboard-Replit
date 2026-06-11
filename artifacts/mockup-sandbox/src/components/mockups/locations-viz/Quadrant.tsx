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

const MOVE_COLOR = { up: "#1a5c38", down: "#b91c1c", flat: "#9ca3af" } as const;
const clampX = (v: number) => Math.max(M.l, Math.min(M.l + IW, v));
const clampY = (v: number) => Math.max(M.t, Math.min(M.t + IH, v));

const plotted = STORES.filter((s) => s.convReliable && s.conversion != null);
const notPlotted = STORES.filter((s) => !s.convReliable);

const composite = (s: StoreRow) =>
  (s.prev!.dConv / (NETWORK.netConv || 1)) + (s.prev!.dAbv / (NETWORK.netAbv || 1));

const movers = plotted.filter((s) => s.prev).map((s) => ({ s, score: composite(s) }));
const improving = movers.filter((m) => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
const sliding = movers.filter((m) => m.score < 0).sort((a, b) => a.score - b.score).slice(0, 3);

export function Quadrant() {
  const [hover, setHover] = useState<StoreRow | null>(null);

  return (
    <div className="min-h-screen w-full" style={{ background: "#f7efe7", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div className="mx-auto max-w-[980px] px-7 py-7">
        <div className="rounded-2xl bg-white shadow-sm border border-black/5 overflow-hidden">
          <div className="px-7 pt-6 pb-4 border-b border-black/5">
            <div className="text-[11px] font-semibold tracking-[0.14em] uppercase" style={{ color: "#1a5c38" }}>
              Store check-up
            </div>
            <h2 className="mt-1 text-[22px] font-semibold tracking-tight text-neutral-900">
              Are people buying, and how much do they spend?
            </h2>
            <p className="mt-1 text-[13px] text-neutral-500 leading-relaxed max-w-[660px]">
              Across the bottom: how many visitors buy something. Up the side: how much each customer spends.
              The dotted lines are the company average — top-right is the best place to be. Bigger circle = more
              sales made (number of sales). The arrows show how each store moved since last month ({NETWORK.prevWindow}). {NETWORK.window}.
            </p>
          </div>

          {/* biggest movers strip */}
          <div className="px-7 py-3.5 border-b border-black/5 flex flex-wrap items-start gap-x-8 gap-y-3" style={{ background: "#fcf9f4" }}>
            <MoverGroup label="Most improved" dir="up" movers={improving} />
            <div className="w-px self-stretch bg-black/5 hidden md:block" />
            <MoverGroup label="Slipping the most" dir="down" movers={sliding} />
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
              <text x={M.l + IW - 8} y={M.t + 18} textAnchor="end" className="fill-neutral-400" style={{ fontSize: 11, fontWeight: 600 }}>Doing well — many buy and spend a lot</text>
              <text x={M.l + 8} y={M.t + 18} textAnchor="start" className="fill-neutral-400" style={{ fontSize: 11, fontWeight: 600 }}>Big spenders, but few buy</text>
              <text x={M.l + IW - 8} y={M.t + IH - 10} textAnchor="end" className="fill-neutral-400" style={{ fontSize: 11, fontWeight: 600 }}>Many buy, but spend little</text>
              <text x={M.l + 8} y={M.t + IH - 10} textAnchor="start" className="fill-neutral-400" style={{ fontSize: 11, fontWeight: 600 }}>Needs help — few buy, low spend</text>

              {/* axes */}
              <line x1={M.l} y1={M.t + IH} x2={M.l + IW} y2={M.t + IH} stroke="#000" opacity={0.18} />
              <line x1={M.l} y1={M.t} x2={M.l} y2={M.t + IH} stroke="#000" opacity={0.18} />
              {[0, 5, 10, 15, 20].map((c) => (
                <text key={c} x={xScale(c)} y={M.t + IH + 20} textAnchor="middle" className="fill-neutral-500" style={{ fontSize: 11 }}>{c}%</text>
              ))}
              {[5000, 7500, 10000, 12500].map((a) => (
                <text key={a} x={M.l - 10} y={yScale(a) + 4} textAnchor="end" className="fill-neutral-500" style={{ fontSize: 11 }}>{(a / 1000).toFixed(0)}k</text>
              ))}
              <text x={M.l + IW / 2} y={H - 14} textAnchor="middle" className="fill-neutral-600" style={{ fontSize: 12, fontWeight: 600 }}>How many visitors buy</text>
              <text transform={`rotate(-90 18 ${M.t + IH / 2})`} x={18} y={M.t + IH / 2} textAnchor="middle" className="fill-neutral-600" style={{ fontSize: 12, fontWeight: 600 }}>Average spend per sale (KES)</text>
              <text x={netX} y={M.t - 6} textAnchor="middle" style={{ fontSize: 10.5, fontWeight: 700, fill: "#1a5c38" }}>company avg {NETWORK.netConv}%</text>

              {/* movement trails (since last month) */}
              <defs>
                {(["up", "down", "flat"] as const).map((d) => (
                  <marker key={d} id={`arrow-${d}`} markerWidth={6} markerHeight={6} refX={4.6} refY={2.4} orient="auto">
                    <path d="M0,0 L5,2.4 L0,4.8 Z" fill={MOVE_COLOR[d]} fillOpacity={0.6} />
                  </marker>
                ))}
              </defs>
              {plotted.filter((s) => s.prev).map((s) => {
                const p = s.prev!;
                const x1 = clampX(xScale(p.prevConv));
                const y1 = clampY(yScale(p.prevAbv));
                const cx = clampX(xScale(s.conversion as number));
                const cy = clampY(yScale(s.abv));
                const col = MOVE_COLOR[p.dir];
                const r = rScale(s.orders);
                const dx = cx - x1, dy = cy - y1;
                const len = Math.hypot(dx, dy) || 1;
                // stop the trail short of the bubble edge so the arrowhead reads cleanly
                const ex = cx - (dx / len) * (r + 3);
                const ey = cy - (dy / len) * (r + 3);
                const active = hover?.store === s.store;
                if (len < r + 6) return null; // negligible movement: skip to avoid clutter
                return (
                  <g key={`tr-${s.store}`} opacity={active ? 0.95 : 0.5}>
                    <line x1={x1} y1={y1} x2={ex} y2={ey} stroke={col} strokeWidth={active ? 2 : 1.4} markerEnd={`url(#arrow-${p.dir})`} />
                    <circle cx={x1} cy={y1} r={2.6} fill="#fff" stroke={col} strokeWidth={1.3} />
                  </g>
                );
              })}

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
                    <Row k="Visitors who buy" v={fmtPct(hover.conversion)} />
                    <Row k="Average spend" v={fmtKES(hover.abv)} />
                    <Row k="Sales (count)" v={hover.orders.toLocaleString()} />
                    <Row k="Total sales" v={fmtKES(hover.sales)} />
                    <Row k="Visitors" v={hover.footfall.toLocaleString()} />
                  </div>
                  {hover.prev && (
                    <div className="mt-2.5 pt-2.5 border-t border-black/5 text-[11px]">
                      <div className="font-semibold mb-1" style={{ color: MOVE_COLOR[hover.prev.dir] }}>
                        {hover.prev.dir === "up" ? "Better" : hover.prev.dir === "down" ? "Worse" : "About the same"} than last month
                      </div>
                      <div className="flex items-center justify-between text-neutral-500">
                        <span>Visitors who buy</span>
                        <span className="tabular-nums font-medium" style={{ color: hover.prev.dConv >= 0 ? "#1a5c38" : "#b91c1c" }}>
                          {hover.prev.dConv >= 0 ? "+" : ""}{hover.prev.dConv.toFixed(1)} pts
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-neutral-500">
                        <span>Average spend</span>
                        <span className="tabular-nums font-medium" style={{ color: hover.prev.dAbv >= 0 ? "#1a5c38" : "#b91c1c" }}>
                          {hover.prev.dAbv >= 0 ? "+" : "−"}{fmtKES(Math.abs(hover.prev.dAbv)).replace("KES ", "")}
                        </span>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-[12px] text-neutral-400 leading-relaxed">Point at any circle to see its numbers.</div>
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
              bigger circle = more sales made
            </div>
            <div className="flex items-center gap-3 text-[12px] text-neutral-500">
              <span className="flex items-center gap-1.5">
                <svg width="22" height="8"><line x1="1" y1="4" x2="17" y2="4" stroke="#1a5c38" strokeWidth="1.6" /><path d="M16,1.6 L21,4 L16,6.4 Z" fill="#1a5c38" /></svg>
                getting better
              </span>
              <span className="flex items-center gap-1.5">
                <svg width="22" height="8"><line x1="1" y1="4" x2="17" y2="4" stroke="#b91c1c" strokeWidth="1.6" /><path d="M16,1.6 L21,4 L16,6.4 Z" fill="#b91c1c" /></svg>
                getting worse
              </span>
              <span className="flex items-center gap-1.5">
                <svg width="22" height="8"><line x1="1" y1="4" x2="17" y2="4" stroke="#9ca3af" strokeWidth="1.6" /><path d="M16,1.6 L21,4 L16,6.4 Z" fill="#9ca3af" /></svg>
                no change
              </span>
              <span className="text-neutral-400">since last month</span>
            </div>
          </div>
          {notPlotted.length > 0 && (
            <div className="px-7 pb-5 -mt-1">
              <div className="rounded-lg bg-neutral-50 border border-black/5 px-4 py-2.5 text-[12px] text-neutral-500">
                <span className="font-semibold text-neutral-600">Not shown (no reliable visitor count):</span>{" "}
                {notPlotted.map((s, i) => (
                  <span key={s.store}>
                    {s.store}
                    {s.noFootfall ? " (online — no shop visitors)" : ` (counter down ${s.sensorGap}/30 days)`}
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

function MoverGroup({ label, dir, movers }: { label: string; dir: "up" | "down"; movers: { s: StoreRow; score: number }[] }) {
  const col = dir === "up" ? "#1a5c38" : "#b91c1c";
  return (
    <div className="flex-1 min-w-[300px]">
      <div className="flex items-center gap-1.5 mb-2">
        <svg width="20" height="8">
          <line x1="1" y1="4" x2="15" y2="4" stroke={col} strokeWidth="1.6" />
          <path d="M14,1.6 L19,4 L14,6.4 Z" fill={col} />
        </svg>
        <span className="text-[11px] font-semibold tracking-[0.1em] uppercase" style={{ color: col }}>{label}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {movers.length === 0 ? (
          <span className="text-[12px] text-neutral-400">No qualifying stores</span>
        ) : (
          movers.map((m) => <MoverChip key={m.s.store} s={m.s} />)
        )}
      </div>
    </div>
  );
}

function MoverChip({ s }: { s: StoreRow }) {
  const p = s.prev!;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-black/5 bg-white px-2.5 py-1.5 shadow-sm">
      <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: ACCENT[s.country] }} />
      <span className="text-[12.5px] font-semibold text-neutral-800 whitespace-nowrap">{s.store}</span>
      <span className="text-[11px] tabular-nums whitespace-nowrap" style={{ color: p.dConv >= 0 ? "#1a5c38" : "#b91c1c" }}>
        {p.dConv >= 0 ? "+" : ""}{p.dConv.toFixed(1)}pt
      </span>
      <span className="text-[11px] tabular-nums whitespace-nowrap" style={{ color: p.dAbv >= 0 ? "#1a5c38" : "#b91c1c" }}>
        {p.dAbv >= 0 ? "+" : "−"}{fmtKES(Math.abs(p.dAbv)).replace("KES ", "")}
      </span>
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
