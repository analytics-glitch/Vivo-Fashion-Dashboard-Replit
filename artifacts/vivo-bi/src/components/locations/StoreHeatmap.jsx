import { useMemo } from "react";
import { fmtKES, fmtPct, countryColor } from "@/lib/api";

// Per-store heatmap matrix, graduated from the canvas mockup.
// Props:
//   stores  — array of { store, country, sales, abv, conversion,
//             salesPerVisitor, sensorGap, lowVolume, noFootfall, convReliable }
//   network — { netConv, netAbv, netSpv, window }
// Cells are coloured relative to the company average: green = better, red =
// worse. Total sales is grey (a size, not a verdict). Striped cells mean the
// visitor counter was down too long to trust conversion / sales-per-visitor.

// diverging background relative to network: >1 green, <1 red, ~1 neutral cream
function divergingBg(value, base) {
  if (value == null || !base) return "transparent";
  const ratio = value / base;
  const t = Math.max(-1, Math.min(1, (ratio - 1) / 0.5)); // clamp +/-50%
  if (t >= 0) return `rgba(26, 92, 56, ${(t * 0.55).toFixed(3)})`; // safari green
  return `rgba(185, 28, 28, ${(-t * 0.5).toFixed(3)})`; // clearance red
}

const textColor = (value, base) => {
  if (value == null || !base) return "#9ca3af";
  return Math.abs(value / base - 1) > 0.32 ? "#fff" : "#1f2937";
};

export default function StoreHeatmap({ stores = [], network }) {
  const maxSales = useMemo(
    () => Math.max(1, ...stores.map((s) => s.sales || 0)),
    [stores]
  );
  const greyBg = (value) => {
    const t = (value || 0) / maxSales;
    return `rgba(55, 65, 81, ${(0.07 + t * 0.33).toFixed(3)})`;
  };
  const greyText = (value) => ((value || 0) / maxSales > 0.55 ? "#fff" : "#1f2937");

  const netConv = network?.netConv ?? 0;
  const netAbv = network?.netAbv ?? 0;
  const netSpv = network?.netSpv ?? 0;

  if (!stores.length) {
    return (
      <div className="rounded-2xl bg-white shadow-sm border border-black/5 overflow-hidden" data-testid="locations-heatmap">
        <div className="px-7 pt-6 pb-4 border-b border-black/5">
          <div className="text-[11px] font-semibold tracking-[0.14em] uppercase" style={{ color: "#1a5c38" }}>Where to focus</div>
          <h2 className="mt-1 text-[22px] font-semibold tracking-tight text-neutral-900">How each store is doing</h2>
        </div>
        <div className="px-7 py-10 text-[13px] text-neutral-500">No store data in this period.</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white shadow-sm border border-black/5 overflow-hidden" data-testid="locations-heatmap">
      <div className="px-7 pt-6 pb-4 border-b border-black/5">
        <div className="text-[11px] font-semibold tracking-[0.14em] uppercase" style={{ color: "#1a5c38" }}>
          Where to focus
        </div>
        <h2 className="mt-1 text-[22px] font-semibold tracking-tight text-neutral-900">
          How each store is doing
        </h2>
        <p className="mt-1 text-[13px] text-neutral-500 leading-relaxed max-w-[640px]">
          Look at the colours, not the numbers.{" "}
          <span style={{ color: "#1a5c38", fontWeight: 600 }}>Green is better</span> than the company average,{" "}
          <span style={{ color: "#b91c1c", fontWeight: 600 }}>red is worse</span>. Total sales is grey because it only
          shows how big a store is, not how well it is doing.
          {network?.window ? ` ${network.window}.` : ""}
        </p>
      </div>

      <div className="px-4 py-2 overflow-x-auto">
        <table className="w-full border-separate" style={{ borderSpacing: "3px" }}>
          <thead>
            <tr>
              <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-400 px-3 py-2">Store</th>
              {["Visitors who buy", "Sales per visitor", "Average spend", "Total sales"].map((h) => (
                <th key={h} className="text-center text-[11px] font-semibold uppercase tracking-wide text-neutral-400 px-2 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* pinned company average */}
            <tr>
              <td className="px-3 py-2 text-[12.5px] font-semibold text-neutral-700 whitespace-nowrap">Company average</td>
              <Cell text={fmtPct(netConv)} bg="rgba(26,92,56,0.10)" color="#1a5c38" bold />
              <Cell text={fmtKES(netSpv)} bg="rgba(26,92,56,0.10)" color="#1a5c38" bold />
              <Cell text={fmtKES(netAbv)} bg="rgba(26,92,56,0.10)" color="#1a5c38" bold />
              <Cell text="—" bg="rgba(55,65,81,0.06)" color="#9ca3af" />
            </tr>
            {stores.map((s) => {
              const unreliable = !s.convReliable;
              return (
                <tr key={s.store}>
                  <td className="px-3 py-2 text-[12.5px] text-neutral-700 whitespace-nowrap">
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: countryColor(s.country) }} />
                      {s.store}
                      {s.lowVolume && <span className="text-[10px] text-neutral-400">(few sales)</span>}
                    </span>
                  </td>
                  {unreliable && s.noFootfall ? (
                    <HatchCell label="online" />
                  ) : unreliable ? (
                    <HatchCell label="no counter" />
                  ) : (
                    <Cell text={fmtPct(s.conversion)} bg={divergingBg(s.conversion, netConv)} color={textColor(s.conversion, netConv)} />
                  )}
                  {unreliable ? (
                    <Cell text="—" bg="transparent" color="#cbd5e1" />
                  ) : (
                    <Cell text={fmtKES(s.salesPerVisitor)} bg={divergingBg(s.salesPerVisitor, netSpv)} color={textColor(s.salesPerVisitor, netSpv)} />
                  )}
                  <Cell text={fmtKES(s.abv)} bg={divergingBg(s.abv, netAbv)} color={textColor(s.abv, netAbv)} />
                  <Cell text={fmtKES(s.sales)} bg={greyBg(s.sales)} color={greyText(s.sales)} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-7 py-4 border-t border-black/5 text-[12px] text-neutral-500 leading-relaxed">
        <span className="font-semibold text-neutral-600">How to read it:</span> if a store is red on both
        "visitors who buy" and "sales per visitor", not enough people are buying — work on welcoming and closing
        the sale. If it is red only on "average spend", customers buy but spend little — suggest add-ons and
        higher-value items. Striped boxes mean the visitor counter was down too long to trust those numbers.
      </div>
    </div>
  );
}

function Cell({ text, bg, color, bold }) {
  return (
    <td className="text-center px-2 py-2 rounded-md tabular-nums" style={{ background: bg, color, fontSize: 12.5, fontWeight: bold ? 700 : 500 }}>
      {text}
    </td>
  );
}

function HatchCell({ label }) {
  return (
    <td
      className="text-center px-2 py-2 rounded-md"
      style={{
        fontSize: 10.5,
        color: "#9ca3af",
        background: "repeating-linear-gradient(45deg, rgba(0,0,0,0.035) 0 6px, rgba(0,0,0,0) 6px 12px)",
      }}
    >
      {label}
    </td>
  );
}
