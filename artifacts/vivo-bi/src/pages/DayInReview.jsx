import React, { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import {
  CalendarBlank, CaretLeft, CaretRight, CheckCircle, XCircle, Trophy,
  ArrowUp, ArrowDown, WarningCircle, Storefront, Globe, Users, Tag,
  Footprints, RocketLaunch, Receipt, ArrowClockwise,
} from "@phosphor-icons/react";

/**
 * Day in Review — automatic decomposition of any closed trading day.
 *
 * One endpoint (/api/day-review/report?date=) returns every section plus
 * deterministic "What worked" / "What's not working" callouts. Sections
 * fail independently server-side; each carries its own {error} so a partial
 * API failure renders as an explicit per-section error — never as
 * fake-healthy zeroes.
 */

// ── formatting helpers ────────────────────────────────────────────────────────
const KES = (v) =>
  v == null ? "—" : `KES ${Math.abs(v) >= 1_000_000
    ? (v / 1_000_000).toFixed(2) + "M"
    : Math.abs(v) >= 1_000
    ? (v / 1_000).toFixed(0) + "k"
    : Number(v).toFixed(0)}`;

const KESfull = (v) => (v == null ? "—" : `KES ${Math.round(v).toLocaleString()}`);
const NUM = (v) => (v == null ? "—" : Math.round(v).toLocaleString());
const PCT = (v, dp = 1) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(dp)}%`;

const GREEN = "#1a5c38";
const RED = "#dc2626";
const AMBER = "#d97706";
const GREY = "#6b7280";

// EAT (UTC+3) yesterday — the report's default day.
const eatYesterday = () => {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const shiftDay = (iso, days) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const prettyDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
};

// ── atoms ─────────────────────────────────────────────────────────────────────
function DeltaPill({ pct, invert = false, suffix = "%" }) {
  if (pct == null) return <span style={{ fontSize: 11, color: GREY }}>—</span>;
  const goodDir = invert ? pct < 0 : pct >= 0;
  const color = Math.abs(pct) < 0.05 ? GREY : goodDir ? GREEN : RED;
  const Icon = pct >= 0 ? ArrowUp : ArrowDown;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 2, color,
      fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
    }}>
      <Icon size={11} weight="bold" />
      {`${pct >= 0 ? "+" : ""}${Number(pct).toFixed(1)}${suffix}`}
    </span>
  );
}

function Card({ children, style }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
      padding: 16, ...style,
    }}>
      {children}
    </div>
  );
}

function SectionError({ msg }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px",
      background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8,
      color: "#92400e", fontSize: 13,
    }}>
      <WarningCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>This section couldn't load — the rest of the report is unaffected.
        <span style={{ display: "block", fontSize: 11, color: "#b45309", marginTop: 2 }}>{msg}</span>
      </span>
    </div>
  );
}

function Section({ icon: Icon, title, sub, data, children, style }) {
  const errored = !data || data.error;
  return (
    <Card style={style}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        {Icon && <Icon size={16} color={GREEN} style={{ alignSelf: "center" }} />}
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "#111827" }}>{title}</h3>
        {sub && <span style={{ fontSize: 12, color: GREY }}>{sub}</span>}
      </div>
      {errored
        ? <SectionError msg={data?.error || "No data returned for this section."} />
        : children}
    </Card>
  );
}

function KpiCard({ label, value, pct, invert, norm }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
      padding: "12px 14px", minWidth: 0,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: GREY, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 800, color: "#111827", margin: "3px 0 2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {value}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <DeltaPill pct={pct} invert={invert} />
        {norm != null && <span style={{ fontSize: 11, color: GREY }}>norm {norm}</span>}
      </div>
    </div>
  );
}

function Bullets({ items, color, Icon, emptyText }) {
  if (!items || items.length === 0) {
    return <div style={{ fontSize: 13, color: GREY, padding: "4px 0" }}>{emptyText}</div>;
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((b, i) => (
        <li key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "#1f2937", lineHeight: 1.45 }}>
          <Icon size={15} color={color} weight="fill" style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{b.text}</span>
        </li>
      ))}
    </ul>
  );
}

// Horizontal mover bar (shared scale across both directions).
function MoverRow({ r, maxAbs }) {
  const up = r.delta_kes >= 0;
  const w = maxAbs > 0 ? Math.max(2, (Math.abs(r.delta_kes) / maxAbs) * 100) : 2;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <div style={{ width: 118, fontSize: 12, fontWeight: 600, color: "#374151", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r.store}>
        {r.store}
      </div>
      <div style={{ flex: 1, minWidth: 40 }}>
        <div style={{
          width: `${w}%`, height: 14, borderRadius: 3,
          background: up ? "rgba(26,92,56,0.75)" : "rgba(220,38,38,0.65)",
        }} />
      </div>
      <div style={{ width: 132, textAlign: "right", fontSize: 12, whiteSpace: "nowrap" }}>
        <span style={{ fontWeight: 700, color: up ? GREEN : RED }}>
          {up ? "+" : "−"}{KES(Math.abs(r.delta_kes)).replace("KES ", "")}
        </span>
        <span style={{ color: GREY, marginLeft: 5 }}>
          {r.delta_pct == null ? (r.base_days_present === 0 ? "new" : "") : PCT(r.delta_pct, 0)}
        </span>
      </div>
    </div>
  );
}

const th = { textAlign: "left", padding: "6px 8px", fontSize: 11, color: GREY, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" };
const td = { padding: "6px 8px", fontSize: 12.5, color: "#1f2937", borderBottom: "1px solid #f3f4f6", whiteSpace: "nowrap" };
const tdR = { ...td, textAlign: "right" };
const thR = { ...th, textAlign: "right" };

function Skeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {[64, 120, 180, 180].map((h, i) => (
        <div key={i} style={{ height: h, borderRadius: 10, background: "linear-gradient(90deg,#f3f4f6,#e5e7eb,#f3f4f6)", backgroundSize: "200% 100%", animation: "dirPulse 1.4s ease-in-out infinite" }} />
      ))}
      <style>{`@keyframes dirPulse { 0%{background-position:0% 0} 100%{background-position:-200% 0} }`}</style>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────
export default function DayInReview() {
  const maxDay = eatYesterday();
  const [day, setDay] = useState(maxDay);

  const { data, isLoading, isFetching, error, refetch } = useApi(
    "/day-review/report", // api client baseURL is already "/api"
    { date: day },
    { placeholderData: (prev) => prev, staleTime: 5 * 60_000 },
  );

  const h = data?.headline && !data.headline.error ? data.headline : null;
  const movers = useMemo(() => {
    const rows = (data?.stores?.rows || []).filter((r) => r.day_kes !== 0 || r.norm_kes !== 0);
    const ups = rows.filter((r) => r.delta_kes > 0).slice(0, 9);
    const downs = rows.filter((r) => r.delta_kes < 0).sort((a, b) => a.delta_kes - b.delta_kes).slice(0, 9);
    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.delta_kes)));
    return { ups, downs, maxAbs };
  }, [data]);

  const launches = data?.styles && !data.styles.error ? data.styles.launch_cohort : null;
  // Guard typed input too: partially-typed years (e.g. "0202-…") arrive as
  // valid ISO strings below the data floor and would 400 against the API.
  const setDay_ = (v) => { if (v && v >= "2021-06-01" && v <= maxDay) setDay(v); };

  return (
    <div style={{ maxWidth: 1240, margin: "0 auto", padding: "18px 16px 60px" }}>
      {/* Header — flex-wrap keeps the date controls mobile-safe */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <CalendarBlank size={22} color={GREEN} weight="duotone" />
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 800, color: "#111827" }}>Day in Review</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginLeft: "auto" }}>
          <button onClick={() => setDay_(shiftDay(day, -1))} title="Previous day"
            style={{ border: "1px solid #d1d5db", background: "#fff", borderRadius: 6, padding: "5px 7px", cursor: "pointer", display: "flex" }}>
            <CaretLeft size={14} />
          </button>
          <input
            type="date" value={day} max={maxDay} min="2021-06-01"
            onChange={(e) => setDay_(e.target.value)}
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "5px 8px", fontSize: 13, fontFamily: "inherit" }}
          />
          <button onClick={() => setDay_(shiftDay(day, 1))} disabled={day >= maxDay} title="Next day"
            style={{ border: "1px solid #d1d5db", background: "#fff", borderRadius: 6, padding: "5px 7px", cursor: day >= maxDay ? "default" : "pointer", opacity: day >= maxDay ? 0.4 : 1, display: "flex" }}>
            <CaretRight size={14} />
          </button>
          {day !== maxDay && (
            <button onClick={() => setDay(maxDay)}
              style={{ border: `1px solid ${GREEN}`, color: GREEN, background: "#f0fdf4", borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              Yesterday
            </button>
          )}
          {isFetching && !isLoading && (
            <ArrowClockwise size={15} color={GREY} style={{ animation: "dirSpin 1s linear infinite" }} />
          )}
        </div>
      </div>
      <div style={{ fontSize: 13, color: GREY, marginBottom: 16 }}>
        {prettyDate(day)} — what drove the day, and what didn't work, vs the norm for that weekday
        (average of the prior 4 same weekdays).
      </div>
      <style>{`@keyframes dirSpin { to { transform: rotate(360deg); } }`}</style>

      {isLoading && <Skeleton />}

      {!isLoading && error && (
        <Card style={{ borderColor: "#fca5a5", background: "#fef2f2" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <WarningCircle size={20} color={RED} />
            <div style={{ fontSize: 14, color: "#991b1b", fontWeight: 600 }}>
              Couldn't load the report{error?.response?.data?.detail ? ` — ${error.response.data.detail}` : ""}.
            </div>
            <button onClick={() => refetch()}
              style={{ marginLeft: "auto", border: `1px solid ${RED}`, color: RED, background: "#fff", borderRadius: 6, padding: "6px 12px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              Retry
            </button>
          </div>
        </Card>
      )}

      {!isLoading && !error && data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

          {/* ── Headline ── */}
          {h ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#111827" }}>{KESfull(h.total_sales)}</div>
                <DeltaPill pct={h.delta_pct} />
                <span style={{ fontSize: 13, color: GREY }}>vs typical {h.weekday} {KES(h.norm_total_sales)}</span>
                {h.rank_label && (
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    background: h.rank === 1 || (h.rank_non_dec === 1 && h.rank > 1) ? "#fefce8" : "#f9fafb",
                    border: `1px solid ${h.rank === 1 || h.rank_non_dec === 1 ? "#fde047" : "#e5e7eb"}`,
                    borderRadius: 999, padding: "4px 12px", fontSize: 12, fontWeight: 700, color: "#854d0e",
                  }}>
                    <Trophy size={13} weight="fill" color={h.rank === 1 || h.rank_non_dec === 1 ? "#ca8a04" : GREY} />
                    {h.rank_label}
                  </span>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 10 }}>
                <KpiCard label="Orders" value={NUM(h.orders)} pct={h.orders_delta_pct} norm={NUM(h.norm_orders)} />
                <KpiCard label="Avg order value" value={KES(h.aov)} pct={h.aov_delta_pct} norm={KES(h.norm_aov)} />
                <KpiCard label="Units" value={NUM(h.units)} pct={h.units_delta_pct} norm={NUM(h.norm_units)} />
                <KpiCard label="Avg selling price" value={KES(h.asp)} pct={h.asp_delta_pct} norm={KES(h.norm_asp)} />
                <KpiCard label="Discounts" value={KES(h.discounts)} pct={h.discount_rate_pct != null && h.norm_discount_rate_pct != null ? +(h.discount_rate_pct - h.norm_discount_rate_pct).toFixed(1) : null} invert suffix="pp" norm={`${h.norm_discount_rate_pct ?? "—"}% rate`} />
                <KpiCard label="Returns" value={KES(h.returns)} pct={h.returns_delta_pct} invert norm={KES(h.norm_returns)} />
              </div>
            </>
          ) : (
            <Card><SectionError msg={data?.headline?.error || "Headline unavailable."} /></Card>
          )}

          {/* ── Callouts ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
            <Card style={{ borderColor: "#bbf7d0", background: "#f6fdf8" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
                <CheckCircle size={17} color={GREEN} weight="fill" />
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: GREEN }}>What worked</h3>
              </div>
              {data.callouts?.error
                ? <SectionError msg={data.callouts.error} />
                : <Bullets items={data.callouts?.working} color={GREEN} Icon={CheckCircle}
                    emptyText="Nothing cleared the materiality bar — a steady day." />}
            </Card>
            <Card style={{ borderColor: "#fecaca", background: "#fef8f8" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
                <XCircle size={17} color={RED} weight="fill" />
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: RED }}>What's not working</h3>
              </div>
              {data.callouts?.error
                ? <SectionError msg={data.callouts.error} />
                : <Bullets items={data.callouts?.not_working} color={RED} Icon={XCircle}
                    emptyText="No material drags detected on this day." />}
            </Card>
          </div>

          {/* ── Store movers ── */}
          <Section icon={Storefront} title="Store movers" sub="day vs same-weekday norm — both directions" data={data.stores}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 18 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: GREEN, marginBottom: 8 }}>ABOVE NORM</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {movers.ups.length === 0 && <span style={{ fontSize: 12, color: GREY }}>No stores above norm.</span>}
                  {movers.ups.map((r) => <MoverRow key={r.store} r={r} maxAbs={movers.maxAbs} />)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: RED, marginBottom: 8 }}>BELOW NORM</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {movers.downs.length === 0 && <span style={{ fontSize: 12, color: GREY }}>No stores below norm.</span>}
                  {movers.downs.map((r) => <MoverRow key={r.store} r={r} maxAbs={movers.maxAbs} />)}
                </div>
              </div>
            </div>
            {/* Country strip */}
            {data.countries && !data.countries.error && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14, paddingTop: 12, borderTop: "1px dashed #e5e7eb" }}>
                {(data.countries.rows || []).map((c) => (
                  <span key={c.country} style={{
                    display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
                    border: "1px solid #e5e7eb", borderRadius: 999, padding: "4px 10px", background: "#fafafa",
                  }}>
                    <Globe size={12} color={GREY} />
                    <b>{c.country}</b> {KES(c.day_kes)}
                    <DeltaPill pct={c.delta_pct} />
                  </span>
                ))}
              </div>
            )}
          </Section>

          {/* ── Launches + style movement ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
            <Section icon={RocketLaunch} title="New launches" sub="styles whose first sale was ≤ 14 days ago" data={data.styles}>
              {launches && (
                <>
                  <div style={{ fontSize: 13, color: "#1f2937", marginBottom: 10 }}>
                    <b>{launches.n_styles}</b> launch styles sold <b>{KES(launches.day_kes)}</b>
                    {launches.share_of_day_pct != null && <> — <b>{launches.share_of_day_pct.toFixed(1)}%</b> of the day</>}
                  </div>
                  {(launches.top || []).length > 0 ? (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ borderCollapse: "collapse", width: "100%" }}>
                        <thead><tr>
                          <th style={th}>Style</th><th style={th}>First sale</th>
                          <th style={thR}>Day sales</th><th style={thR}>Units</th>
                        </tr></thead>
                        <tbody>
                          {launches.top.slice(0, 7).map((s) => (
                            <tr key={s.style}>
                              <td style={{ ...td, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }} title={s.style}>{s.style}</td>
                              <td style={td}>{s.first_sale}</td>
                              <td style={{ ...tdR, fontWeight: 700 }}>{KES(s.day_kes)}</td>
                              <td style={tdR}>{NUM(s.day_units)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <div style={{ fontSize: 12, color: GREY }}>No launch-cohort sales on this day.</div>}
                </>
              )}
            </Section>

            <Section icon={Tag} title="Style spikes & cooldowns" sub="vs trailing 28-day daily run-rate" data={data.styles}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: GREEN, marginBottom: 6 }}>SPIKING</div>
                  {(data.styles?.spikes || []).length === 0 && <span style={{ fontSize: 12, color: GREY }}>No spikes above the 3× bar.</span>}
                  {(data.styles?.spikes || []).slice(0, 5).map((s) => (
                    <div key={s.style} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, padding: "4px 0", borderBottom: "1px solid #f3f4f6" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.style}>{s.style}</span>
                      <span style={{ whiteSpace: "nowrap" }}>
                        <b style={{ color: GREEN }}>{KES(s.day_kes)}</b>
                        <span style={{ color: GREY }}> vs ~{KES(s.trail_daily_kes)}/d{s.ratio != null ? ` (×${s.ratio})` : ""}</span>
                      </span>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: RED, marginBottom: 6 }}>COOLING</div>
                  {(data.styles?.decliners || []).length === 0 && <span style={{ fontSize: 12, color: GREY }}>No material styles cooled off.</span>}
                  {(data.styles?.decliners || []).slice(0, 5).map((s) => (
                    <div key={s.style} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, padding: "4px 0", borderBottom: "1px solid #f3f4f6" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.style}>{s.style}</span>
                      <span style={{ whiteSpace: "nowrap" }}>
                        <b style={{ color: RED }}>{KES(s.day_kes)}</b>
                        <span style={{ color: GREY }}> vs ~{KES(s.trail_daily_kes)}/d</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </Section>
          </div>

          {/* ── Online + customers ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
            <Section icon={Globe} title="Online" sub="gross vs returns decomposition" data={data.online}>
              {data.online && !data.online.error && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8, marginBottom: 10 }}>
                    <KpiCard label="Gross" value={KES(data.online.gross_kes)} pct={null} norm={KES(data.online.norm_gross_kes)} />
                    <KpiCard label="Returns" value={KES(data.online.returns_kes)} pct={null} norm={KES(data.online.norm_returns_kes)} />
                    <KpiCard label="Net" value={KES(data.online.net_kes)} pct={data.online.net_delta_pct} norm={KES(data.online.norm_net_kes)} />
                  </div>
                  <div style={{ fontSize: 12.5, color: "#374151" }}>
                    {NUM(data.online.orders)} orders (norm {NUM(data.online.norm_orders)}) · AOV {KES(data.online.aov)}
                    {data.online.return_burden_pct != null && (
                      <> · returns ate <b style={{ color: data.online.return_burden_pct >= 15 ? RED : "#374151" }}>
                        {data.online.return_burden_pct.toFixed(1)}%</b> of gross
                        {data.online.norm_return_burden_pct != null && <span style={{ color: GREY }}> (typical {data.online.norm_return_burden_pct.toFixed(1)}%)</span>}
                      </>
                    )}
                  </div>
                </>
              )}
            </Section>

            <Section icon={Users} title="Customers" sub="new vs returning (first-purchase rollup)" data={data.customers}>
              {data.customers && !data.customers.error && (() => {
                const c = data.customers;
                const seg = [
                  { k: "New", v: c.new_sales, n: c.new_customers, col: GREEN },
                  { k: "Returning", v: c.returning_sales, n: c.returning_customers, col: "#0f766e" },
                  { k: "Walk-in / anonymous", v: c.walk_in_sales, n: null, col: "#9ca3af" },
                ].filter((s) => s.v != null);
                const tot = seg.reduce((a, s) => a + (s.v || 0), 0) || 1;
                return (
                  <>
                    <div style={{ display: "flex", height: 16, borderRadius: 5, overflow: "hidden", marginBottom: 10 }}>
                      {seg.map((s) => (
                        <div key={s.k} title={`${s.k}: ${KESfull(s.v)}`}
                          style={{ width: `${Math.max(1, ((s.v || 0) / tot) * 100)}%`, background: s.col }} />
                      ))}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {seg.map((s) => (
                        <div key={s.k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ width: 9, height: 9, borderRadius: 2, background: s.col, display: "inline-block" }} />
                            {s.k}{s.n != null && <span style={{ color: GREY }}>· {NUM(s.n)} customers</span>}
                          </span>
                          <b>{KES(s.v)}</b>
                        </div>
                      ))}
                    </div>
                    {c.norm_new_customers != null && (
                      <div style={{ fontSize: 12, color: GREY, marginTop: 8 }}>
                        Typical {data.meta?.weekday || "weekday"}: ~{NUM(c.norm_new_customers)} new customers
                        {c.norm_new_sales != null && <> ({KES(c.norm_new_sales)})</>}.
                      </div>
                    )}
                  </>
                );
              })()}
            </Section>
          </div>

          {/* ── Categories + big orders ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
            <Section icon={Tag} title="Category mix" sub="share of day vs trailing 28-day share" data={data.categories}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead><tr>
                    <th style={th}>Category</th><th style={thR}>Day sales</th>
                    <th style={thR}>vs run-rate</th><th style={thR}>Share</th><th style={thR}>Δ share</th>
                  </tr></thead>
                  <tbody>
                    {(data.categories?.rows || []).slice(0, 10).map((r) => (
                      <tr key={r.category}>
                        <td style={td}>{r.category}</td>
                        <td style={{ ...tdR, fontWeight: 700 }}>{KES(r.day_kes)}</td>
                        <td style={tdR}><DeltaPill pct={r.delta_pct} /></td>
                        <td style={tdR}>{r.day_share_pct != null ? `${r.day_share_pct.toFixed(1)}%` : "—"}</td>
                        <td style={{ ...tdR, color: (r.share_delta_pp || 0) >= 0 ? GREEN : RED, fontWeight: 600 }}>
                          {r.share_delta_pp != null ? `${r.share_delta_pp >= 0 ? "+" : ""}${r.share_delta_pp.toFixed(1)}pp` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section icon={Receipt} title="Big orders" sub="concentration check — was the day carried by a few receipts?" data={data.big_orders}>
              {data.big_orders && !data.big_orders.error && (
                <>
                  <div style={{ fontSize: 12.5, color: "#374151", marginBottom: 8 }}>
                    Top order = <b>{data.big_orders.top1_share_pct != null ? `${data.big_orders.top1_share_pct.toFixed(1)}%` : "—"}</b> of the day ·
                    {" "}{NUM(data.big_orders.orders_over_50k)} orders ≥ KES 50k
                    {data.big_orders.over_50k_share_pct != null && <> (together {data.big_orders.over_50k_share_pct.toFixed(1)}%)</>}
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead><tr>
                        <th style={th}>Receipt</th><th style={th}>Store</th>
                        <th style={thR}>Value</th><th style={thR}>Units</th><th style={thR}>% of day</th>
                      </tr></thead>
                      <tbody>
                        {(data.big_orders.top || []).map((o) => (
                          <tr key={o.order_name}>
                            <td style={td}>{o.order_name}</td>
                            <td style={td}>{o.store}</td>
                            <td style={{ ...tdR, fontWeight: 700 }}>{KESfull(o.kes)}</td>
                            <td style={tdR}>{NUM(o.units)}</td>
                            <td style={tdR}>{o.share_of_day_pct != null ? `${o.share_of_day_pct.toFixed(1)}%` : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Section>
          </div>

          {/* ── Footfall ── */}
          <Section icon={Footprints} title="Footfall — traffic vs conversion" sub="clean sensors only; dark sensors disclosed, never counted" data={data.footfall}>
            {data.footfall && !data.footfall.error && (
              <>
                {data.footfall.fleet && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                    <span style={{ fontSize: 12.5, border: "1px solid #e5e7eb", borderRadius: 999, padding: "4px 12px", background: "#fafafa" }}>
                      Fleet traffic <b>{NUM(data.footfall.fleet.footfall)}</b> <DeltaPill pct={data.footfall.fleet.traffic_delta_pct} />
                    </span>
                    <span style={{ fontSize: 12.5, border: "1px solid #e5e7eb", borderRadius: 999, padding: "4px 12px", background: "#fafafa" }}>
                      Conversion <b>{data.footfall.fleet.conversion_pct != null ? `${data.footfall.fleet.conversion_pct.toFixed(1)}%` : "—"}</b>
                      {data.footfall.fleet.conversion_delta_pp != null && (
                        <span style={{ color: data.footfall.fleet.conversion_delta_pp >= 0 ? GREEN : RED, fontWeight: 700 }}>
                          {" "}{data.footfall.fleet.conversion_delta_pp >= 0 ? "+" : ""}{data.footfall.fleet.conversion_delta_pp.toFixed(1)}pp
                        </span>
                      )}
                    </span>
                  </div>
                )}
                {(data.footfall.sensors_down || []).length > 0 && (
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 12px", marginBottom: 10, fontSize: 12.5, color: "#92400e" }}>
                    <WarningCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>
                      Sensor dark (sales with zero counted visitors):{" "}
                      {data.footfall.sensors_down.map((s) => `${s.store} (${KES(s.sales_kes)})`).join(", ")} — conversion not measurable there.
                    </span>
                  </div>
                )}
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead><tr>
                      <th style={th}>Store</th><th style={thR}>Footfall</th><th style={thR}>vs norm</th>
                      <th style={thR}>Conversion</th><th style={thR}>Δ conv</th><th style={thR}>Orders</th><th style={thR}>Sales</th>
                    </tr></thead>
                    <tbody>
                      {(data.footfall.rows || []).map((r) => (
                        <tr key={r.store} style={r.sensor_down ? { background: "#fffbeb" } : undefined}>
                          <td style={td}>{r.store}{r.sensor_down && <span style={{ color: AMBER, fontWeight: 700 }}> · sensor down</span>}</td>
                          <td style={tdR}>{r.sensor_down ? "—" : NUM(r.footfall)}</td>
                          <td style={tdR}><DeltaPill pct={r.traffic_delta_pct} /></td>
                          <td style={tdR}>{r.conversion_pct != null ? `${r.conversion_pct.toFixed(1)}%` : "—"}</td>
                          <td style={{ ...tdR, fontWeight: 600, color: r.conversion_delta_pp == null ? GREY : r.conversion_delta_pp >= 0 ? GREEN : RED }}>
                            {r.conversion_delta_pp != null ? `${r.conversion_delta_pp >= 0 ? "+" : ""}${r.conversion_delta_pp.toFixed(1)}pp` : "—"}
                          </td>
                          <td style={tdR}>{NUM(r.orders)}</td>
                          <td style={tdR}>{KES(r.sales_kes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Section>

          <div style={{ fontSize: 11, color: "#9ca3af", textAlign: "center" }}>
            Norm = average of the prior 4 same weekdays ({(data.meta?.baseline_dates || []).join(", ")}).
            Data through {data.meta?.data_through || "—"} · generated {data.meta?.generated_at ? new Date(data.meta.generated_at).toLocaleString() : "—"}.
          </div>
        </div>
      )}
    </div>
  );
}
