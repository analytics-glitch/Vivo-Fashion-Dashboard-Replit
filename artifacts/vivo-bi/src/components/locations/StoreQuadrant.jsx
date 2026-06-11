import { useState, useMemo } from "react";
import { fmtKES, fmtPct, countryColor, COUNTRY_COLORS } from "@/lib/api";

// Conversion-vs-ABV quadrant scatter, graduated from the canvas mockup.
// Props:
//   stores  — array of { store, country, orders, units, sales, abv, footfall,
//             conversion, salesPerVisitor, sensorGap, lowVolume, noFootfall,
//             convReliable, prev?: { prevConv, prevAbv, dConv, dAbv, dir } }
//   network — { netConv, netAbv, netSpv, window, prevWindow }
// X = conversion (% of visitors who buy), Y = average basket value (KES),
// bubble area = number of sales (orders), arrows = movement vs the compare
// period. Scales are derived from the live data so nothing clips.

const W = 940, H = 720;
const M = { t: 28, r: 28, b: 66, l: 96 };
const IW = W - M.l - M.r;
const IH = H - M.t - M.b;

const MOVE_COLOR = { up: "#1a5c38", down: "#b91c1c", flat: "#9ca3af" };

// Round a value up to a "nice" axis maximum (1/2/5 * 10^n).
function niceMax(v) {
  if (!isFinite(v) || v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

const kLabel = (v) => `${(v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, "")}k`;

export default function StoreQuadrant({ stores = [], network }) {
  const [hover, setHover] = useState(null);

  const plotted = useMemo(
    () => stores.filter((s) => s.convReliable && s.conversion != null),
    [stores]
  );
  const notPlotted = useMemo(() => stores.filter((s) => !s.convReliable), [stores]);

  const netConv = network?.netConv ?? 0;
  const netAbv = network?.netAbv ?? 0;

  const { xMax, yMin, yMax } = useMemo(() => {
    const convs = [];
    const abvs = [];
    for (const s of plotted) {
      convs.push(s.conversion);
      abvs.push(s.abv);
      if (s.prev) {
        if (s.prev.prevConv != null) convs.push(s.prev.prevConv);
        if (s.prev.prevAbv != null) abvs.push(s.prev.prevAbv);
      }
    }
    if (network) {
      convs.push(netConv);
      abvs.push(netAbv);
    }
    const xMaxRaw = convs.length ? Math.max(...convs) : 20;
    const aMin = abvs.length ? Math.min(...abvs) : 0;
    const aMax = abvs.length ? Math.max(...abvs) : 10000;
    const pad = Math.max((aMax - aMin) * 0.15, aMax * 0.05, 500);
    return {
      xMax: Math.max(niceMax(xMaxRaw * 1.1), 5),
      yMin: Math.max(0, aMin - pad),
      yMax: aMax + pad,
    };
  }, [plotted, network, netConv, netAbv]);

  const maxOrders = useMemo(
    () => Math.max(1, ...plotted.map((s) => s.orders || 0)),
    [plotted]
  );

  const xScale = (c) => M.l + (c / xMax) * IW;
  const yScale = (a) => M.t + (1 - (a - yMin) / ((yMax - yMin) || 1)) * IH;
  const rScale = (o) => {
    const t = Math.sqrt(Math.min(o || 0, maxOrders) / maxOrders);
    return Math.max(6, Math.min(22, 6 + t * 16));
  };
  const clampX = (v) => Math.max(M.l, Math.min(M.l + IW, v));
  const clampY = (v) => Math.max(M.t, Math.min(M.t + IH, v));

  const netX = xScale(netConv);
  const netY = yScale(netAbv);

  const xTicks = useMemo(() => {
    const n = 4;
    const out = [];
    for (let i = 1; i <= n; i++) out.push(Math.round((xMax * i) / (n + 1)));
    return [...new Set(out)].filter((v) => v > 0);
  }, [xMax]);
  const yTicks = useMemo(() => {
    const n = 4;
    const out = [];
    for (let i = 1; i <= n; i++) out.push(yMin + ((yMax - yMin) * i) / (n + 1));
    return out;
  }, [yMin, yMax]);

  const composite = (s) =>
    (s.prev.dConv ?? 0) / (netConv || 1) + (s.prev.dAbv ?? 0) / (netAbv || 1);
  const movers = plotted.filter((s) => s.prev).map((s) => ({ s, score: composite(s) }));
  const improving = movers.filter((m) => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  const sliding = movers.filter((m) => m.score < 0).sort((a, b) => a.score - b.score).slice(0, 3);
  const hasMovers = improving.length > 0 || sliding.length > 0;

  if (!network || plotted.length === 0) {
    return (
      <div className="rounded-2xl bg-white shadow-sm border border-black/5 overflow-hidden" data-testid="locations-quadrant">
        <div className="px-7 pt-6 pb-4 border-b border-black/5">
          <div className="text-[11px] font-semibold tracking-[0.14em] uppercase" style={{ color: "#1a5c38" }}>
            Store check-up
          </div>
          <h2 className="mt-1 text-[22px] font-semibold tracking-tight text-neutral-900">
            Are people buying, and how much do they spend?
          </h2>
        </div>
        <div className="px-7 py-10 text-[13px] text-neutral-500 leading-relaxed">
          No store has a reliable visitor count in this period, so this chart can't be drawn yet.
          Try a wider date range, or check the full store breakdown below.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white shadow-sm border border-black/5 overflow-hidden" data-testid="locations-quadrant">
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
          sales made (number of sales).
          {network.prevWindow ? ` Hover a circle to see how that store moved since the comparison period (${network.prevWindow}).` : ""}
          {network.window ? ` ${network.window}.` : ""}
        </p>
      </div>

      {hasMovers && (
        <div className="px-7 py-3.5 border-b border-black/5 flex flex-wrap items-start gap-x-8 gap-y-3" style={{ background: "#fcf9f4" }}>
          <MoverGroup label="Most improved" dir="up" movers={improving} />
          <div className="w-px self-stretch bg-black/5 hidden md:block" />
          <MoverGroup label="Slipping the most" dir="down" movers={sliding} />
        </div>
      )}

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full block">
          {/* quadrant tints */}
          <rect x={netX} y={M.t} width={M.l + IW - netX} height={netY - M.t} fill="#1a5c38" opacity={0.05} />
          <rect x={M.l} y={M.t} width={netX - M.l} height={netY - M.t} fill="#d97706" opacity={0.04} />
          <rect x={netX} y={netY} width={M.l + IW - netX} height={M.t + IH - netY} fill="#4b7bec" opacity={0.04} />
          <rect x={M.l} y={netY} width={netX - M.l} height={M.t + IH - netY} fill="#b91c1c" opacity={0.04} />

          {/* gridlines */}
          {xTicks.map((c) => (
            <line key={`gx-${c}`} x1={xScale(c)} y1={M.t} x2={xScale(c)} y2={M.t + IH} stroke="#000" opacity={0.04} />
          ))}
          {yTicks.map((a) => (
            <line key={`gy-${a}`} x1={M.l} y1={yScale(a)} x2={M.l + IW} y2={yScale(a)} stroke="#000" opacity={0.04} />
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
          {xTicks.map((c) => (
            <text key={`tx-${c}`} x={xScale(c)} y={M.t + IH + 20} textAnchor="middle" className="fill-neutral-500" style={{ fontSize: 11 }}>{c}%</text>
          ))}
          {yTicks.map((a) => (
            <text key={`ty-${a}`} x={M.l - 10} y={yScale(a) + 4} textAnchor="end" className="fill-neutral-500" style={{ fontSize: 11 }}>{kLabel(a)}</text>
          ))}
          <text x={M.l + IW / 2} y={H - 14} textAnchor="middle" className="fill-neutral-600" style={{ fontSize: 12, fontWeight: 600 }}>How many visitors buy</text>
          <text transform={`rotate(-90 18 ${M.t + IH / 2})`} x={18} y={M.t + IH / 2} textAnchor="middle" className="fill-neutral-600" style={{ fontSize: 12, fontWeight: 600 }}>Average spend per sale (KES)</text>
          <text x={netX} y={M.t - 6} textAnchor="middle" style={{ fontSize: 10.5, fontWeight: 700, fill: "#1a5c38" }}>company avg {netConv.toFixed(1)}%</text>

          {/* arrow markers for the hovered store's movement trail */}
          <defs>
            {["up", "down", "flat"].map((dd) => (
              <marker key={dd} id={`loc-arrow-${dd}`} markerWidth={6} markerHeight={6} refX={4.6} refY={2.4} orient="auto">
                <path d="M0,0 L5,2.4 L0,4.8 Z" fill={MOVE_COLOR[dd]} />
              </marker>
            ))}
          </defs>

          {/* bubbles — store names and movement arrows are revealed only for
              the hovered store. Drawing every store's name inside the bubble
              and every movement arrow at once produced an unreadable tangle;
              the "Most improved / Slipping" panel above already summarises
              movement, so the default plot is kept clean. */}
          {plotted.map((s) => {
            const cx = xScale(s.conversion);
            const cy = yScale(s.abv);
            const r = rScale(s.orders);
            const c = countryColor(s.country);
            const active = hover?.store === s.store;
            return (
              <circle
                key={s.store}
                cx={cx}
                cy={cy}
                r={r}
                fill={c}
                fillOpacity={active ? 0.5 : 0.22}
                stroke={c}
                strokeWidth={active ? 2.4 : 1.4}
                onMouseEnter={() => setHover(s)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: "pointer" }}
              />
            );
          })}

          {/* hover overlay — drawn last so the active store, its movement
              arrow and its name sit cleanly on top of every other bubble. */}
          {hover && (() => {
            const s = hover;
            const cx = xScale(s.conversion);
            const cy = yScale(s.abv);
            const r = rScale(s.orders);
            const c = countryColor(s.country);
            const p = s.prev;
            let trail = null;
            if (p && p.prevConv != null && p.prevAbv != null) {
              const x1 = clampX(xScale(p.prevConv));
              const y1 = clampY(yScale(p.prevAbv));
              const col = MOVE_COLOR[p.dir] || MOVE_COLOR.flat;
              const dx = cx - x1;
              const dy = cy - y1;
              const len = Math.hypot(dx, dy) || 1;
              if (len >= r + 6) {
                const ex = cx - (dx / len) * (r + 3);
                const ey = cy - (dy / len) * (r + 3);
                trail = (
                  <g>
                    <line x1={x1} y1={y1} x2={ex} y2={ey} stroke={col} strokeWidth={2} markerEnd={`url(#loc-arrow-${p.dir})`} />
                    <circle cx={x1} cy={y1} r={3} fill="#fff" stroke={col} strokeWidth={1.4} />
                  </g>
                );
              }
            }
            return (
              <g pointerEvents="none">
                {trail}
                <circle cx={cx} cy={cy} r={r} fill={c} fillOpacity={0.5} stroke={c} strokeWidth={2.6} />
                <text
                  x={cx}
                  y={cy - r - 7}
                  textAnchor="middle"
                  style={{ fontSize: 12.5, fontWeight: 700, fill: "#111827", paintOrder: "stroke", stroke: "#fff", strokeWidth: 4, strokeLinejoin: "round" }}
                >
                  {s.store}
                </text>
              </g>
            );
          })()}
        </svg>

        {/* hover detail card */}
        <div className="absolute top-4 right-4 w-[210px] rounded-xl border border-black/5 bg-white/95 backdrop-blur shadow-sm px-4 py-3 pointer-events-none">
          {hover ? (
            <>
              <div className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: countryColor(hover.country) }} />
                <span className="text-[13px] font-semibold text-neutral-900">{hover.store}</span>
              </div>
              <div className="mt-2.5 space-y-1.5 text-[12px]">
                <Row k="Visitors who buy" v={fmtPct(hover.conversion)} />
                <Row k="Average spend" v={fmtKES(hover.abv)} />
                <Row k="Sales (count)" v={(hover.orders || 0).toLocaleString()} />
                <Row k="Total sales" v={fmtKES(hover.sales)} />
                <Row k="Visitors" v={(hover.footfall || 0).toLocaleString()} />
              </div>
              {hover.prev && (
                <div className="mt-2.5 pt-2.5 border-t border-black/5 text-[11px]">
                  <div className="font-semibold mb-1" style={{ color: MOVE_COLOR[hover.prev.dir] }}>
                    {hover.prev.dir === "up" ? "Better" : hover.prev.dir === "down" ? "Worse" : "About the same"} than the comparison period
                  </div>
                  <div className="flex items-center justify-between text-neutral-500">
                    <span>Visitors who buy</span>
                    <span className="tabular-nums font-medium" style={{ color: (hover.prev.dConv ?? 0) >= 0 ? "#1a5c38" : "#b91c1c" }}>
                      {(hover.prev.dConv ?? 0) >= 0 ? "+" : ""}{(hover.prev.dConv ?? 0).toFixed(1)} pts
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-neutral-500">
                    <span>Average spend</span>
                    <span className="tabular-nums font-medium" style={{ color: (hover.prev.dAbv ?? 0) >= 0 ? "#1a5c38" : "#b91c1c" }}>
                      {(hover.prev.dAbv ?? 0) >= 0 ? "+" : "−"}{fmtKES(Math.abs(hover.prev.dAbv ?? 0)).replace("KES ", "")}
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
        {["Kenya", "Uganda", "Rwanda", "Online"].map((k) => (
          <div key={k} className="flex items-center gap-1.5 text-[12px] text-neutral-600">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: COUNTRY_COLORS[k] }} />{k}
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-[12px] text-neutral-500">
          <span className="inline-block w-4 h-4 rounded-full border" style={{ borderColor: "#1a5c38" }} />
          <span className="inline-block w-2.5 h-2.5 rounded-full border" style={{ borderColor: "#1a5c38" }} />
          bigger circle = more sales made
        </div>
        {hasMovers && (
          <div className="flex items-center gap-3 text-[12px] text-neutral-500">
            <span className="flex items-center gap-1.5">
              <svg width="22" height="8"><line x1="1" y1="4" x2="17" y2="4" stroke="#1a5c38" strokeWidth="1.6" /><path d="M16,1.6 L21,4 L16,6.4 Z" fill="#1a5c38" /></svg>
              getting better
            </span>
            <span className="flex items-center gap-1.5">
              <svg width="22" height="8"><line x1="1" y1="4" x2="17" y2="4" stroke="#b91c1c" strokeWidth="1.6" /><path d="M16,1.6 L21,4 L16,6.4 Z" fill="#b91c1c" /></svg>
              getting worse
            </span>
            <span className="text-neutral-400">hover a store to see its move</span>
          </div>
        )}
      </div>
      {notPlotted.length > 0 && (
        <div className="px-7 pb-5 -mt-1">
          <div className="rounded-lg bg-neutral-50 border border-black/5 px-4 py-2.5 text-[12px] text-neutral-500">
            <span className="font-semibold text-neutral-600">Not shown (no reliable visitor count):</span>{" "}
            {notPlotted.map((s, i) => (
              <span key={s.store}>
                {s.store}
                {s.noFootfall ? " (online — no shop visitors)" : ` (counter down ${s.sensorGap} day${s.sensorGap === 1 ? "" : "s"})`}
                {i < notPlotted.length - 1 ? " · " : ""}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MoverGroup({ label, dir, movers }) {
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

function MoverChip({ s }) {
  const p = s.prev;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-black/5 bg-white px-2.5 py-1.5 shadow-sm">
      <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: countryColor(s.country) }} />
      <span className="text-[12.5px] font-semibold text-neutral-800 whitespace-nowrap">{s.store}</span>
      <span className="text-[11px] tabular-nums whitespace-nowrap" style={{ color: (p.dConv ?? 0) >= 0 ? "#1a5c38" : "#b91c1c" }}>
        {(p.dConv ?? 0) >= 0 ? "+" : ""}{(p.dConv ?? 0).toFixed(1)}pt
      </span>
      <span className="text-[11px] tabular-nums whitespace-nowrap" style={{ color: (p.dAbv ?? 0) >= 0 ? "#1a5c38" : "#b91c1c" }}>
        {(p.dAbv ?? 0) >= 0 ? "+" : "−"}{fmtKES(Math.abs(p.dAbv ?? 0)).replace("KES ", "")}
      </span>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-neutral-400">{k}</span>
      <span className="font-semibold text-neutral-800 tabular-nums">{v}</span>
    </div>
  );
}
