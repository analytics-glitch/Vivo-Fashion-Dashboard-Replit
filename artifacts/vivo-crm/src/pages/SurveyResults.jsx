import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { RefreshCcw, ClipboardList, Lock } from "lucide-react";

// Community survey results — aggregate-only. The backend never exposes who
// said what: counts, percentages, NPS and anonymous comments per wave.

const errOf = (e) =>
  e?.response?.data?.detail || e?.message || "Something went wrong";

const fmtNum = (n) => Number(n || 0).toLocaleString();
const fmtDur = (s) =>
  s === null || s === undefined
    ? "—"
    : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;

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

function Bar({ pct }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-[var(--vivo-border)]/60 overflow-hidden">
      <div
        className="h-full rounded-full bg-[var(--vivo-navy)]"
        style={{ width: `${Math.max(0, Math.min(100, pct || 0))}%` }}
      />
    </div>
  );
}

function QuestionCard({ q }) {
  if (q.kind === "text") {
    return (
      <Card className="vivo-card rounded-sm p-0">
        <div className="border-b border-[var(--vivo-border)] px-4 py-3">
          <div className="text-[13px] font-semibold text-[var(--vivo-text)]">{q.title}</div>
          <div className="text-[11px] text-[var(--vivo-muted)] mt-0.5">
            {fmtNum(q.answered)} wrote something — latest shown, anonymous
            {(q.comments || []).some((c) => c.includes("?")) && (
              <span className="text-amber-700">
                {" "}· {(q.comments || []).filter((c) => c.includes("?")).length} look like questions — follow up via the Contact Us channels
              </span>
            )}
          </div>
        </div>
        {(q.comments || []).length === 0 ? (
          <div className="px-4 py-6 text-[12px] text-[var(--vivo-muted)]">No comments yet.</div>
        ) : (
          <ul className="divide-y divide-[var(--vivo-border)]/60 max-h-80 overflow-y-auto">
            {q.comments.map((c, i) => (
              <li key={i} className="px-4 py-3 text-[13px] leading-relaxed text-[var(--vivo-text)]">
                “{c}”
                {c.includes("?") && (
                  <span
                    data-testid="survey-comment-question-flag"
                    className="ml-2 inline-flex items-center gap-1 rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-700"
                  >
                    Question — follow up
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }
  return (
    <Card className="vivo-card rounded-sm p-0">
      <div className="border-b border-[var(--vivo-border)] px-4 py-3">
        <div className="text-[13px] font-semibold text-[var(--vivo-text)]">{q.title}</div>
        <div className="text-[11px] text-[var(--vivo-muted)] mt-0.5">
          {fmtNum(q.answered)} answered{q.kind === "multi" ? " — multi-select, so shares can top 100%" : ""}
        </div>
      </div>
      <div className="p-4 space-y-2.5">
        {(q.options || []).map((o) => (
          <div key={o.label} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 items-center">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-[var(--vivo-text)]">{o.label}</span>
              <span className="text-[12px] tabular-nums text-[var(--vivo-muted)] whitespace-nowrap">
                {fmtNum(o.n)} · {o.pct}%
              </span>
            </div>
            <div className="w-24 sm:w-36">
              <Bar pct={o.pct} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function SurveyResults() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = (waveId) => {
    setLoading(true);
    setErr("");
    api
      .get("/crm/community-survey/summary", {
        params: waveId ? { wave_id: waveId } : {},
      })
      .then((r) => setData(r.data))
      .catch((e) => setErr(errOf(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(0);
  }, []);

  const nps = data?.nps;

  return (
    <div className="space-y-4" data-testid="survey-results-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-[var(--vivo-navy)] flex items-center gap-2">
            <ClipboardList size={20} /> Community survey
          </h1>
          <p className="text-[12px] text-[var(--vivo-muted)] mt-0.5 flex items-center gap-1.5">
            <Lock size={11} /> Aggregate and anonymous — individual answers are never shown.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(data?.waves || []).length > 1 && (
            <select
              data-testid="sr-wave-select"
              value={data?.wave?.id || ""}
              onChange={(e) => load(Number(e.target.value))}
              className="h-9 rounded-sm border border-[var(--vivo-border)] bg-white px-2 text-[13px] text-[var(--vivo-text)]"
            >
              {data.waves.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.title} ({w.wave_key}) — {fmtNum(w.responses)}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => load(data?.wave?.id || 0)}
            className="h-9 px-3 rounded-sm border border-[var(--vivo-border)] bg-white text-[13px] text-[var(--vivo-text)] inline-flex items-center gap-1.5 hover:bg-[var(--vivo-bg)]"
          >
            <RefreshCcw size={13} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {err && (
        <Card className="vivo-card rounded-sm p-4 text-[13px] text-red-700">{err}</Card>
      )}

      {!err && data && !data.wave && (
        <Card className="vivo-card rounded-sm p-8 text-center text-[13px] text-[var(--vivo-muted)]">
          No survey waves yet — the first wave is seeded with the app.
        </Card>
      )}

      {!err && data?.wave && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi
              label="Responses"
              value={fmtNum(data.n)}
              sub={`${data.wave.title} (${data.wave.wave_key})`}
            />
            <Kpi
              label="NPS"
              value={nps ? nps.score : "—"}
              sub={
                nps
                  ? `${fmtNum(nps.promoters)} promoters · ${fmtNum(nps.passives)} passive · ${fmtNum(nps.detractors)} detractors`
                  : "No scores yet"
              }
            />
            <Kpi label="Avg score" value={nps ? nps.avg : "—"} sub="0–10 recommend scale" />
            <Kpi label="Median time" value={fmtDur(data.median_duration_secs)} sub="Designed for under 3 minutes" />
          </div>

          {(data.by_tier || []).length > 0 && (
            <Card className="vivo-card rounded-sm p-0">
              <div className="border-b border-[var(--vivo-border)] px-4 py-3 text-[13px] font-semibold text-[var(--vivo-text)]">
                Who answered (by tier at completion)
              </div>
              <div className="divide-y divide-[var(--vivo-border)]/60">
                {data.by_tier.map((t) => (
                  <div key={t.tier} className="px-4 py-2.5 flex items-center justify-between text-[13px]">
                    <span className="text-[var(--vivo-text)]">{t.tier}</span>
                    <span className="tabular-nums text-[var(--vivo-muted)]">
                      {fmtNum(t.n)} responses{t.nps !== null && t.nps !== undefined ? ` · NPS ${t.nps}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {data.n === 0 ? (
            <Card className="vivo-card rounded-sm p-8 text-center text-[13px] text-[var(--vivo-muted)]">
              No responses yet — members see the survey on their Home feed, in
              Rewards and under Profile.
            </Card>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {(data.questions || []).map((q) => (
                <QuestionCard key={q.id} q={q} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
