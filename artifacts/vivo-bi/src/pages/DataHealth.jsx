import React, { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { SectionTitle, Loading, ErrorBox } from "@/components/common";
import { ArrowsClockwise, CheckCircle, WarningCircle, XCircle, Database } from "@phosphor-icons/react";

const STATUS = {
  ok: { cls: "pill-green", icon: CheckCircle, label: "OK" },
  empty: { cls: "pill-amber", icon: WarningCircle, label: "Empty" },
  missing: { cls: "pill-red", icon: XCircle, label: "Missing" },
};

const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString());

/**
 * Data Health & Parity (admin-only).
 *
 * Production is a SEPARATE database from dev — publishing ships code + schema
 * but NOT data rows, so several hand-loaded / self-bootstrapping tables can be
 * empty or stale in prod. This page reports row counts + freshness for the
 * database THIS site is connected to. Open it on the published site AND in dev
 * and the numbers should line up; after every publish, confirm the "Empty"
 * critical tables have filled in.
 */
const DataHealth = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .get("/admin/data-health")
      .then((r) => setData(r.data))
      .catch((e) => setError(e?.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const tables = data?.tables || [];
  const groups = [...new Set(tables.map((t) => t.group))];

  return (
    <div className="space-y-5" data-testid="data-health-page">
      <div className="flex items-start justify-between gap-4">
        <SectionTitle
          title="Data Health & Parity"
          subtitle="Row counts and freshness for the database this site is connected to"
        />
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand text-white font-semibold text-[13px] hover:bg-brand-deep shrink-0"
          data-testid="data-health-refresh"
        >
          <ArrowsClockwise size={14} weight="bold" /> Refresh
        </button>
      </div>

      <div className="card-white p-4 border-l-4 border-l-sky-400 bg-sky-50/40 text-[12.5px] text-muted">
        <b className="text-foreground">How to check prod matches dev:</b> open this page on your
        published site and here in dev — the numbers should line up. Production runs on a{" "}
        <b>separate database</b>, and publishing copies code &amp; structure but not data rows. After
        every publish, confirm the <b>Empty</b> critical tables below have filled in. A table that
        stays empty still needs its data bootstrapped.
      </div>

      {loading && <Loading />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && data && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="pill-neutral inline-flex items-center gap-1">
              <Database size={12} /> {data.database || "unknown DB"}
            </span>
            <span className="pill-green">{data.summary?.ok || 0} OK</span>
            {(data.summary?.empty || 0) > 0 && <span className="pill-amber">{data.summary.empty} empty</span>}
            {(data.summary?.missing || 0) > 0 && <span className="pill-red">{data.summary.missing} missing</span>}
            {data.generated_at && (
              <span className="text-muted">checked {new Date(data.generated_at).toLocaleString()}</span>
            )}
          </div>

          {groups.map((g) => (
            <div key={g} className="card-white p-5">
              <h3 className="font-extrabold text-[12px] uppercase tracking-wide text-muted mb-3">{g}</h3>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-muted text-left border-b border-border">
                    <th className="py-1.5 font-semibold">Table</th>
                    <th className="py-1.5 font-semibold text-right">Rows</th>
                    <th className="py-1.5 font-semibold text-left pl-4">Data span</th>
                    <th className="py-1.5 font-semibold text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tables
                    .filter((t) => t.group === g)
                    .map((t) => {
                      const s = STATUS[t.status] || STATUS.missing;
                      const Icon = s.icon;
                      const span =
                        t.earliest && t.latest ? `${t.earliest} → ${t.latest}` : t.latest || "—";
                      return (
                        <tr key={t.key} className="border-b border-border/60" data-testid={`dh-row-${t.key}`}>
                          <td className="py-2">
                            <div className="font-semibold">
                              {t.label}
                              {t.critical && (
                                <span className="text-rose-500" title="Expected to be non-empty">
                                  {" "}
                                  *
                                </span>
                              )}
                            </div>
                            <div className="font-mono text-[11px] text-muted">{t.key}</div>
                          </td>
                          <td className="py-2 text-right tabular-nums font-semibold">{fmtNum(t.rows)}</td>
                          <td className="py-2 pl-4 text-muted">{span}</td>
                          <td className="py-2 text-right">
                            <span className={`${s.cls} inline-flex items-center gap-1`} title={t.error || ""}>
                              <Icon size={11} weight="fill" />
                              {s.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          ))}
          <p className="text-[11px] text-muted">* expected to be non-empty in a healthy database.</p>
        </>
      )}
    </div>
  );
};

export default DataHealth;
