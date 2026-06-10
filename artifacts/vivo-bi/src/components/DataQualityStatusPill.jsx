import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canAccessPage } from "@/lib/permissions";
import { CheckCircle, Warning, WarningOctagon, Spinner } from "@phosphor-icons/react";

/**
 * Topbar data-quality pill. Polls `/api/data-quality/report` every 5 min
 * and surfaces the overall score at a glance:
 *   • Green  — score > 90
 *   • Amber  — 75–90
 *   • Red    — < 75
 *
 * Click → popover listing each quality check with its score. Visible to any
 * role allowed to see the Data Quality page; hidden otherwise.
 */
const DataQualityStatusPill = () => {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const allowed = !!user && canAccessPage(user, "data-quality");

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { data: d } = await api.get("/data-quality/report");
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setData({ error: e?.response?.data?.detail || e.message || "check failed" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    tick();
    const id = setInterval(tick, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [allowed]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!e.target.closest?.('[data-testid="dq-status-pill"]') &&
          !e.target.closest?.('[data-testid="dq-status-panel"]')) {
        setOpen(false);
      }
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  if (!allowed) return null;

  const endpointError = !!data?.error;
  const score = typeof data?.overall_score === "number" ? data.overall_score : null;
  const status = loading
    ? "loading"
    : endpointError || score === null ? "red"
      : score > 90 ? "green"
        : score >= 75 ? "amber"
          : "red";

  const cls = {
    loading: "bg-panel text-muted border-border",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-800 border-amber-200",
    red: "bg-rose-50 text-rose-700 border-rose-200",
  }[status];

  const Icon = { loading: Spinner, green: CheckCircle, amber: Warning, red: WarningOctagon }[status];

  const label = loading
    ? "DQ —"
    : endpointError ? "DQ offline"
      : `DQ ${Math.round(score)}`;

  const checkColor = (s) =>
    s > 90 ? "text-emerald-700" : s >= 75 ? "text-amber-700" : "text-rose-700";

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="dq-status-pill"
        title="Data quality — click for details"
        className={`hidden lg:inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10.5px] font-semibold transition-colors ${cls}`}
      >
        <Icon size={11} weight={status === "green" ? "fill" : "regular"}
              className={status === "loading" ? "animate-spin" : ""} />
        <span>{label}</span>
      </button>

      {open && data && (
        <div
          data-testid="dq-status-panel"
          className="absolute right-0 top-full mt-2 w-[380px] max-w-[92vw] z-50 bg-white border border-border rounded-xl shadow-xl p-4 text-foreground"
        >
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="font-bold text-[13px]">Data Quality</div>
              <div className="text-[11px] text-muted">Overall score across all checks</div>
            </div>
            {!endpointError && score !== null && (
              <div className={`font-extrabold tabular-nums text-[18px] ${checkColor(score)}`}>
                {Math.round(score)}
              </div>
            )}
          </div>

          {endpointError ? (
            <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-rose-700 text-[12px]">
              Data quality endpoint unreachable: {data.error}
            </div>
          ) : (
            <div className="space-y-1">
              {(data.checks || []).map((c) => (
                <div
                  key={c.check}
                  className="flex items-start justify-between gap-2 px-2 py-1.5 rounded-md bg-panel/60"
                  data-testid={`dq-check-${c.check}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[11.5px] font-semibold capitalize">
                      {String(c.check || "").replace(/_/g, " ")}
                    </div>
                    {c.detail && (
                      <div className="text-[10.5px] text-muted truncate">{c.detail}</div>
                    )}
                  </div>
                  <div className={`text-[12px] font-bold tabular-nums ${checkColor(c.score)}`}>
                    {typeof c.score === "number" ? Math.round(c.score) : "—"}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
            <span className="text-[10.5px] text-muted">Polls every 5 min</span>
            <Link
              to="/data-quality"
              onClick={() => setOpen(false)}
              className="text-[11px] font-semibold text-brand hover:underline"
              data-testid="dq-open-page"
            >
              Open Data Quality
            </Link>
          </div>
        </div>
      )}
    </div>
  );
};

export default DataQualityStatusPill;
