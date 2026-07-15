import React, { useEffect, useState, useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { SectionTitle, Loading, ErrorBox } from "@/components/common";
import {
  ClipboardText,
  Package,
  Sparkle,
  ArrowsClockwise,
  Repeat,
  Truck,
  WarningCircle,
  CalendarCheck,
} from "@phosphor-icons/react";

/**
 * Production Pipeline — Overview tab. A one-glance cockpit over the buying
 * order book, styled like the main Overview page's KPI cards. Reads the same
 * /api/production/summary + /flow the report uses, but answers the executive
 * questions in one screen:
 *   • How many buying orders, how many units ordered?
 *   • How does the book split by order type (New / Replenishment / Re-order)?
 *   • What state are the orders in (draft → partially → fully planned)?
 *   • Where is the work physically (stage snapshot, active orders only)?
 *   • What is landing (due soon) and what is late (overdue)?
 */

function fmtQty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v)
    ? v.toLocaleString()
    : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return String(d);
  }
}

function titleize(s) {
  if (!s) return "—";
  return String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const LIFECYCLE_META = {
  New: { icon: Sparkle, color: "#059669", bg: "bg-emerald-500" },
  Replenishment: { icon: ArrowsClockwise, color: "#0284c7", bg: "bg-sky-500" },
  "Re-order": { icon: Repeat, color: "#7c3aed", bg: "bg-violet-500" },
};

const STATE_COLORS = {
  fully_planned: "bg-emerald-500",
  partially_planned: "bg-amber-500",
  draft: "bg-gray-400",
  bom_pending: "bg-rose-400",
};

/** Single horizontal segmented bar with a legend — for BO state / order type mix. */
function SegmentBar({ title, rows, colorFor, unitLabel = "orders", metric = "orders", testId }) {
  const data = (rows || []).filter((r) => Number(r[metric]) > 0);
  const total = data.reduce((s, r) => s + (Number(r[metric]) || 0), 0);
  return (
    <div className="card-white p-4" data-testid={testId}>
      <div className="eyebrow mb-3">{title}</div>
      {total === 0 ? (
        <div className="text-[12px] text-muted italic">No data.</div>
      ) : (
        <>
          <div className="flex h-3 rounded-full overflow-hidden bg-panel/70">
            {data.map((r) => (
              <div
                key={r.label}
                className={colorFor(r.label)}
                style={{ width: `${(Number(r[metric]) / total) * 100}%` }}
                title={`${titleize(r.label)}: ${fmtQty(r[metric])} ${unitLabel}`}
              />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {data.map((r) => {
              const pct = (Number(r[metric]) / total) * 100;
              return (
                <div key={r.label} className="flex items-center gap-1.5 text-[12px]">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${colorFor(r.label)}`} />
                  <span className="font-semibold text-[#0f3d24]">{titleize(r.label)}</span>
                  <span className="text-muted tabular-nums">
                    {fmtQty(r[metric])} · {pct.toFixed(0)}%
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** Compact stage snapshot — where the active units physically sit right now. */
function StageSnapshot({ byStage, terminalKeys }) {
  const rows = (byStage || []).filter(
    (s) => !terminalKeys.has(s.stage_key) && Number(s.units) > 0
  );
  const total = rows.reduce((s, r) => s + (Number(r.units) || 0), 0);
  return (
    <div className="card-white p-4" data-testid="prod-ov-stage-snapshot">
      <div className="eyebrow mb-2">Where the work is (units in progress)</div>
      {rows.length === 0 ? (
        <div className="text-[12px] text-muted italic">Nothing currently in progress.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const pct = total > 0 ? (Number(r.units) / total) * 100 : 0;
            return (
              <div key={r.stage_key}>
                <div className="flex items-center justify-between gap-2 text-[12.5px]">
                  <span className="font-semibold text-[#0f3d24] truncate">
                    {r.stage_name}
                    {r.live && (
                      <span className="ml-1.5 text-[10px] font-medium text-emerald-600 align-middle">
                        live
                      </span>
                    )}
                  </span>
                  <span className="text-muted whitespace-nowrap tabular-nums">
                    {fmtQty(r.units)} u · {fmtQty(r.orders)} orders · {pct.toFixed(0)}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-panel/70 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-brand"
                    style={{ width: `${Math.max(pct, pct > 0 ? 3 : 0)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Delivery outlook — overdue vs landing soon, from expected_delivery_date. */
function DeliveryOutlook({ overdue, dueSoon, onOpenReport }) {
  const Section = ({ icon: Icon, tone, title, rows, emptyText, testId }) => (
    <div data-testid={testId}>
      <div className={`flex items-center gap-1.5 text-[12px] font-semibold ${tone} mb-1.5`}>
        <Icon size={14} weight="bold" />
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-[12px] text-muted italic">{emptyText}</div>
      ) : (
        <div className="space-y-1">
          {rows.slice(0, 6).map((o) => (
            <div
              key={o.order_ref}
              className="flex items-center justify-between gap-2 text-[12px]"
            >
              <span className="truncate">
                <span className="font-semibold text-[#0f3d24]">{o.order_ref}</span>
                <span className="text-muted"> · {o.style_name || o.product_name || o.style_number || "—"}</span>
              </span>
              <span className="text-muted whitespace-nowrap tabular-nums">
                {fmtQty(o.order_qty)} u · {fmtDate(o.expected_delivery_date)}
              </span>
            </div>
          ))}
          {rows.length > 6 &&
            (typeof onOpenReport === "function" ? (
              <button
                type="button"
                onClick={onOpenReport}
                className="text-[11.5px] font-semibold text-brand hover:underline"
              >
                +{rows.length - 6} more in the Production Report
              </button>
            ) : (
              <div className="text-[11.5px] text-muted">
                +{rows.length - 6} more
              </div>
            ))}
        </div>
      )}
    </div>
  );
  return (
    <div className="card-white p-4 space-y-4" data-testid="prod-ov-delivery">
      <div className="eyebrow">Delivery outlook (active orders)</div>
      <Section
        icon={WarningCircle}
        tone="text-rose-600"
        title={`Overdue (${overdue.length})`}
        rows={overdue}
        emptyText="Nothing overdue."
        testId="prod-ov-overdue"
      />
      <Section
        icon={CalendarCheck}
        tone="text-emerald-700"
        title={`Due in the next 14 days (${dueSoon.length})`}
        rows={dueSoon}
        emptyText="Nothing due in the next two weeks."
        testId="prod-ov-due-soon"
      />
    </div>
  );
}

export default function ProductionOverview({ onOpenReport }) {
  const [data, setData] = useState(null);
  const [flow, setFlow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    const opts = force ? { forceFresh: true } : {};
    try {
      const [summaryRes, flowRes] = await Promise.all([
        api.get("/production/summary", opts),
        api.get("/production/flow", opts),
      ]);
      setData(summaryRes.data);
      setFlow(flowRes.data);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || "Failed to load the production overview");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const totals = data?.totals || { orders: 0, units: 0, styles: 0 };
  const byLifecycle = data?.by_lifecycle || [];
  const orders = data?.orders || [];

  const terminalKeys = useMemo(
    () => new Set((flow?.stages || []).filter((s) => s.is_terminal).map((s) => s.stage_key)),
    [flow]
  );

  // An order is "complete" once ALL of its units sit in a terminal (warehouse)
  // stage — same rule the Production Report uses for its completed table.
  const isComplete = useCallback(
    (o) => {
      const sq = o.stage_qty || {};
      let term = 0;
      let nonTerm = 0;
      for (const [k, v] of Object.entries(sq)) {
        const n = Number(v) || 0;
        if (terminalKeys.has(k)) term += n;
        else nonTerm += n;
      }
      return term > 0 && nonTerm === 0;
    },
    [terminalKeys]
  );

  const activeOrders = useMemo(() => orders.filter((o) => !isComplete(o)), [orders, isComplete]);
  const completedCount = orders.length - activeOrders.length;

  const inProgressUnits = useMemo(
    () =>
      (data?.by_stage || []).reduce(
        (s, r) => (terminalKeys.has(r.stage_key) ? s : s + (Number(r.units) || 0)),
        0
      ),
    [data, terminalKeys]
  );

  // Delivery outlook buckets (active orders with an expected date only).
  // Dates are compared as local-calendar YYYY-MM-DD strings — never Date
  // objects — so a "2026-07-15" expected date can't drift a day for users
  // in other timezones (new Date("YYYY-MM-DD") parses as UTC midnight).
  const { overdue, dueSoon } = useMemo(() => {
    const toLocalISO = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    const todayStr = toLocalISO(now);
    const horizon = new Date(now);
    horizon.setDate(horizon.getDate() + 14);
    const horizonStr = toLocalISO(horizon);
    const od = [];
    const ds = [];
    for (const o of activeOrders) {
      const raw = o.expected_delivery_date;
      if (!raw) continue;
      const dateStr = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
      if (dateStr < todayStr) od.push(o);
      else if (dateStr <= horizonStr) ds.push(o);
    }
    const byDate = (a, b) =>
      String(a.expected_delivery_date).localeCompare(String(b.expected_delivery_date));
    od.sort(byDate);
    ds.sort(byDate);
    return { overdue: od, dueSoon: ds };
  }, [activeOrders]);

  // Last-30-days intake — momentum of new buying orders.
  const recent30 = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    cutoff.setHours(0, 0, 0, 0);
    let n = 0;
    let units = 0;
    for (const o of orders) {
      if (!o.date_ordered) continue;
      const d = new Date(o.date_ordered);
      if (!Number.isNaN(d.getTime()) && d >= cutoff) {
        n += 1;
        units += Number(o.order_qty) || 0;
      }
    }
    return { orders: n, units };
  }, [orders]);

  const lc = useCallback(
    (label) => byLifecycle.find((r) => r.label === label) || { orders: 0, units: 0 },
    [byLifecycle]
  );
  const share = useCallback(
    (n) => (totals.orders > 0 ? `${((Number(n) / totals.orders) * 100).toFixed(0)}% of orders` : undefined),
    [totals.orders]
  );

  if (loading) return <Loading label="Loading production overview…" />;
  if (error) return <ErrorBox message={error} />;

  const lcNew = lc("New");
  const lcRep = lc("Replenishment");
  const lcReo = lc("Re-order");

  return (
    <div className="space-y-4" data-testid="production-overview">
      <SectionTitle
        title="Buying Orders at a Glance"
        subtitle={`Whole order book · ${fmtQty(completedCount)} completed, ${fmtQty(activeOrders.length)} active · ${fmtQty(recent30.orders)} new orders placed in the last 30 days (${fmtQty(recent30.units)} units)`}
        action={
          <button
            type="button"
            onClick={() => load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-3 py-2 rounded-md disabled:opacity-50"
            data-testid="prod-ov-refresh"
          >
            <ArrowsClockwise size={14} weight="bold" className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        }
      />

      {/* Hero KPI row — same card language as the main Overview page. */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KPICard
          testId="prod-ov-kpi-orders"
          accent
          label="Buying Orders"
          value={fmtQty(totals.orders)}
          icon={ClipboardText}
          sub={`${fmtQty(totals.styles)} distinct styles`}
          formula="Every buying order in the book — including completed and not-yet-started."
          showDelta={false}
        />
        <KPICard
          testId="prod-ov-kpi-units"
          label="Units Ordered"
          value={fmtQty(totals.units)}
          icon={Package}
          sub={`${fmtQty(inProgressUnits)} still in progress`}
          formula="Total ordered quantity across all buying orders. 'In progress' excludes units already landed in the warehouse."
          showDelta={false}
        />
        <KPICard
          testId="prod-ov-kpi-new"
          label="New Styles"
          value={fmtQty(lcNew.orders)}
          icon={Sparkle}
          sub={`${fmtQty(lcNew.units)} units · ${share(lcNew.orders) || "—"}`}
          formula="Buying orders introducing a NEW style to the range."
          showDelta={false}
        />
        <KPICard
          testId="prod-ov-kpi-replen"
          label="Replenishments"
          value={fmtQty(lcRep.orders)}
          icon={ArrowsClockwise}
          sub={`${fmtQty(lcRep.units)} units · ${share(lcRep.orders) || "—"}`}
          formula="Buying orders topping up styles already selling."
          showDelta={false}
        />
        <KPICard
          testId="prod-ov-kpi-reorder"
          label="Re-orders"
          value={fmtQty(lcReo.orders)}
          icon={Repeat}
          sub={`${fmtQty(lcReo.units)} units · ${share(lcReo.orders) || "—"}`}
          formula="Repeat buying orders of proven styles."
          showDelta={false}
        />
        <KPICard
          testId="prod-ov-kpi-landing"
          label="Landing / Late"
          value={`${fmtQty(dueSoon.length)} / ${fmtQty(overdue.length)}`}
          icon={Truck}
          sub="due ≤ 14 days / overdue"
          formula="Active orders by expected delivery date: landing within 14 days vs already past their expected date."
          showDelta={false}
        />
      </div>

      {/* Mix bars — order type + buying-order state. */}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
        <SegmentBar
          title="Order type mix (by units)"
          rows={byLifecycle}
          metric="units"
          unitLabel="units"
          colorFor={(label) => LIFECYCLE_META[label]?.bg || "bg-gray-400"}
          testId="prod-ov-lifecycle-mix"
        />
        <SegmentBar
          title="Buying-order state (by orders)"
          rows={data?.by_state}
          metric="orders"
          unitLabel="orders"
          colorFor={(label) => STATE_COLORS[label] || "bg-gray-400"}
          testId="prod-ov-state-mix"
        />
      </div>

      {/* Stage snapshot + delivery outlook. */}
      <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
        <StageSnapshot byStage={data?.by_stage} terminalKeys={terminalKeys} />
        <DeliveryOutlook overdue={overdue} dueSoon={dueSoon} onOpenReport={onOpenReport} />
      </div>
    </div>
  );
}
