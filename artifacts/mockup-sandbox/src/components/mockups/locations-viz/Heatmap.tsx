import { STORES, NETWORK, ACCENT, fmtKES, fmtKESk, fmtPct, type StoreRow } from "./data";

const maxSales = Math.max(...STORES.map((s) => s.sales));

// diverging background relative to network: >1 green, <1 red, ~1 neutral cream
function divergingBg(value: number | null, base: number): string {
  if (value == null) return "transparent";
  const ratio = value / base;
  const t = Math.max(-1, Math.min(1, (ratio - 1) / 0.5)); // clamp +/-50%
  if (t >= 0) {
    const a = (t * 0.55).toFixed(3);
    return `rgba(26, 92, 56, ${a})`; // safari green
  }
  const a = (-t * 0.5).toFixed(3);
  return `rgba(185, 28, 28, ${a})`; // clearance red
}

// neutral grey scale for total sales (context, not a verdict)
function greyBg(value: number): string {
  const t = value / maxSales;
  return `rgba(55, 65, 81, ${(0.07 + t * 0.33).toFixed(3)})`;
}

const textColor = (value: number | null, base: number) => {
  if (value == null) return "#9ca3af";
  return Math.abs(value / base - 1) > 0.32 ? "#fff" : "#1f2937";
};
const greyText = (value: number) => (value / maxSales > 0.55 ? "#fff" : "#1f2937");

export function Heatmap() {
  return (
    <div className="min-h-screen w-full" style={{ background: "#f7efe7", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div className="mx-auto max-w-[820px] px-7 py-7">
        <div className="rounded-2xl bg-white shadow-sm border border-black/5 overflow-hidden">
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
              shows how big a store is, not how well it is doing. {NETWORK.window}.
            </p>
          </div>

          <div className="px-4 py-2">
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
                {/* pinned network average */}
                <tr>
                  <td className="px-3 py-2 text-[12.5px] font-semibold text-neutral-700 whitespace-nowrap">Company average</td>
                  <Cell text={fmtPct(NETWORK.netConv)} bg="rgba(26,92,56,0.10)" color="#1a5c38" bold />
                  <Cell text={fmtKES(NETWORK.netSpv)} bg="rgba(26,92,56,0.10)" color="#1a5c38" bold />
                  <Cell text={fmtKES(NETWORK.netAbv)} bg="rgba(26,92,56,0.10)" color="#1a5c38" bold />
                  <Cell text="—" bg="rgba(55,65,81,0.06)" color="#9ca3af" />
                </tr>
                {STORES.map((s) => (
                  <Row key={s.store} s={s} />
                ))}
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
      </div>
    </div>
  );
}

function Row({ s }: { s: StoreRow }) {
  const unreliable = !s.convReliable;
  return (
    <tr>
      <td className="px-3 py-2 text-[12.5px] text-neutral-700 whitespace-nowrap">
        <span className="inline-flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: ACCENT[s.country] }} />
          {s.store}
          {s.lowVolume && <span className="text-[10px] text-neutral-400">(few sales)</span>}
        </span>
      </td>
      {unreliable && s.noFootfall ? (
        <HatchCell label="online" />
      ) : unreliable ? (
        <HatchCell label="no counter" />
      ) : (
        <Cell text={fmtPct(s.conversion)} bg={divergingBg(s.conversion, NETWORK.netConv)} color={textColor(s.conversion, NETWORK.netConv)} />
      )}
      {unreliable ? (
        <Cell text="—" bg="transparent" color="#cbd5e1" />
      ) : (
        <Cell text={fmtKES(s.salesPerVisitor as number)} bg={divergingBg(s.salesPerVisitor, NETWORK.netSpv)} color={textColor(s.salesPerVisitor, NETWORK.netSpv)} />
      )}
      <Cell text={fmtKES(s.abv)} bg={divergingBg(s.abv, NETWORK.netAbv)} color={textColor(s.abv, NETWORK.netAbv)} />
      <Cell text={fmtKESk(s.sales)} bg={greyBg(s.sales)} color={greyText(s.sales)} />
    </tr>
  );
}

function Cell({ text, bg, color, bold }: { text: string; bg: string; color: string; bold?: boolean }) {
  return (
    <td className="text-center px-2 py-2 rounded-md tabular-nums" style={{ background: bg, color, fontSize: 12.5, fontWeight: bold ? 700 : 500 }}>
      {text}
    </td>
  );
}

function HatchCell({ label }: { label: string }) {
  return (
    <td
      className="text-center px-2 py-2 rounded-md"
      style={{
        fontSize: 10.5,
        color: "#9ca3af",
        background:
          "repeating-linear-gradient(45deg, rgba(0,0,0,0.035) 0 6px, rgba(0,0,0,0) 6px 12px)",
      }}
    >
      {label}
    </td>
  );
}
