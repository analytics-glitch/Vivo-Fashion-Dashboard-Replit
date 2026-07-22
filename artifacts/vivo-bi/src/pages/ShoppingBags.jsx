import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Loading, ErrorBox } from "@/components/common";
import { ArrowsClockwise, WarningCircle, CheckCircle, Package } from "@phosphor-icons/react";

const REPLEN_THRESHOLD = 70;
const REPLEN_QTY = 100;

function StatCard({ label, value, sub }) {
  return (
    <div className="card-white p-4">
      <div className="text-xs text-muted uppercase tracking-wide mb-1">{label}</div>
      <div className="text-2xl font-semibold text-foreground tabular-nums">{value ?? "—"}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function BagCell({ val }) {
  const n = Number(val) || 0;
  return (
    <td className="px-3 py-2.5 text-right tabular-nums text-sm">
      {n > 0 ? n : <span className="text-muted">—</span>}
    </td>
  );
}

export default function ShoppingBags() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get("/inventory/shopping-bags");
      setData(res.data);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e.message || "Failed to load shopping bags data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  if (!data) return null;

  const { stores = [], warehouse = {}, grand_total = 0 } = data;
  const lowStores = stores.filter((s) => Number(s.total) < REPLEN_THRESHOLD);
  const wh = warehouse || {};

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Shopping Bags</h2>
          <p className="text-xs text-muted mt-0.5">
            Current stock by store · Replenishment recommended at &lt;{REPLEN_THRESHOLD} units
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground border border-border rounded px-2.5 py-1.5 transition-colors"
        >
          <ArrowsClockwise size={13} />
          Refresh
          {lastRefresh && (
            <span className="ml-1 text-[11px] text-muted">
              {lastRefresh.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Stores in Stock"
          value={stores.length}
          sub="active locations"
        />
        <StatCard
          label="Total Store Stock"
          value={grand_total.toLocaleString()}
          sub="across all stores"
        />
        <StatCard
          label="Warehouse Stock"
          value={Number(wh.total || 0).toLocaleString()}
          sub="Shopping Bags location"
        />
        <StatCard
          label="Needs Replenishment"
          value={lowStores.length}
          sub={`stores below ${REPLEN_THRESHOLD} units`}
        />
      </div>

      {/* Replenishment alert */}
      {lowStores.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3.5">
          <div className="flex items-start gap-2">
            <WarningCircle size={16} weight="fill" className="text-amber-600 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-amber-800">
                {lowStores.length} {lowStores.length === 1 ? "store needs" : "stores need"} replenishment
              </div>
              <div className="text-xs text-amber-700 mt-0.5">
                Recommended: send <strong>{REPLEN_QTY} pcs</strong> to each store below {REPLEN_THRESHOLD} units.
                Stores: {lowStores.map((s) => s.store).join(", ")}.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Warehouse breakdown */}
      {wh.total > 0 && (
        <div className="card-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted mb-3 flex items-center gap-1.5">
            <Package size={13} />
            Warehouse Stock (Shopping Bags location)
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            {[
              { label: "Vivo Small", val: wh.vivo_small },
              { label: "Vivo Medium", val: wh.vivo_medium },
              { label: "Vivo Large", val: wh.vivo_large },
              { label: "Zoya", val: wh.zoya },
              { label: "Safari", val: wh.safari },
            ].map(({ label, val }) => (
              <div key={label} className="text-center">
                <div className="text-lg font-semibold tabular-nums">{Number(val || 0).toLocaleString()}</div>
                <div className="text-xs text-muted mt-0.5">{label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-store table */}
      <div className="card-white overflow-hidden">
        <div className="px-4 pt-4 pb-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Stock by Store</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-[#f9f5f0]">
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">Store</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">Vivo S</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">Vivo M</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">Vivo L</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">Zoya</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">Safari</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">Total</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted uppercase tracking-wide whitespace-nowrap">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {stores.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-sm text-muted">No store data available</td>
                </tr>
              )}
              {stores.map((row) => {
                const total = Number(row.total) || 0;
                const low = total < REPLEN_THRESHOLD;
                return (
                  <tr key={row.store} className={low ? "bg-red-50" : "hover:bg-[#f9f5f0]"}>
                    <td className="px-3 py-2.5 text-sm font-medium text-foreground whitespace-nowrap">
                      {row.store}
                    </td>
                    <BagCell val={row.vivo_small} />
                    <BagCell val={row.vivo_medium} />
                    <BagCell val={row.vivo_large} />
                    <BagCell val={row.zoya} />
                    <BagCell val={row.safari} />
                    <td className="px-3 py-2.5 text-right tabular-nums text-sm font-semibold">
                      <span className={low ? "text-red-700" : "text-foreground"}>{total}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      {low ? (
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
                            <WarningCircle size={10} weight="fill" />
                            Low stock
                          </span>
                          <span className="text-[11px] text-muted">
                            Send {REPLEN_QTY}
                          </span>
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
                          <CheckCircle size={10} weight="fill" />
                          OK
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {stores.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-border bg-[#f9f5f0] font-medium">
                  <td className="px-3 py-2.5 text-sm">Total</td>
                  <td className="px-3 py-2.5 text-right text-sm tabular-nums">
                    {stores.reduce((a, r) => a + (Number(r.vivo_small) || 0), 0)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm tabular-nums">
                    {stores.reduce((a, r) => a + (Number(r.vivo_medium) || 0), 0)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm tabular-nums">
                    {stores.reduce((a, r) => a + (Number(r.vivo_large) || 0), 0)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm tabular-nums">
                    {stores.reduce((a, r) => a + (Number(r.zoya) || 0), 0)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm tabular-nums">
                    {stores.reduce((a, r) => a + (Number(r.safari) || 0), 0)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm tabular-nums font-semibold">{grand_total}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
