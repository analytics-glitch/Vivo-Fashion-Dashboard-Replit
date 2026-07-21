import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtKESLong, fmtNum } from "@/lib/api";
import { Loading, ErrorBox, Empty } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { Storefront } from "@phosphor-icons/react";

const VENDORS = ["All", "Soko", "TIE", "Ythera"];

const VENDOR_CLS = {
  Soko:   "bg-emerald-100 text-emerald-700",
  TIE:    "bg-indigo-100  text-indigo-700",
  Ythera: "bg-amber-100   text-amber-700",
};

const VendorBadge = ({ vendor }) => (
  <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${VENDOR_CLS[vendor] ?? "bg-slate-100 text-slate-600"}`}>
    {vendor}
  </span>
);

const COLS = [
  {
    key: "pos_location",
    label: "POS Location",
    render: (r) => r.pos_location,
  },
  {
    key: "vendor",
    label: "Product Vendor",
    render: (r) => <VendorBadge vendor={r.vendor} />,
    csv: (r) => r.vendor,
  },
  {
    key: "subcategory",
    label: "Subcategory",
    render: (r) => r.subcategory || "—",
  },
  {
    key: "product_title",
    label: "Product Title",
    render: (r) => r.product_title,
  },
  {
    key: "sku",
    label: "SKU",
    render: (r) => <span className="font-mono text-xs text-slate-500">{r.sku || "—"}</span>,
    csv: (r) => r.sku,
  },
  {
    key: "price",
    label: "Price",
    numeric: true,
    render: (r) => (r.price != null ? fmtKESLong(r.price) : "—"),
    csv: (r) => r.price ?? "",
  },
  {
    key: "discount",
    label: "Discount",
    numeric: true,
    render: (r) => fmtKESLong(r.discount || 0),
    csv: (r) => r.discount ?? 0,
  },
  {
    key: "returns",
    label: "Returns",
    numeric: true,
    render: (r) => (
      <span className={(r.returns || 0) < 0 ? "text-rose-600 font-medium" : ""}>
        {fmtKESLong(r.returns || 0)}
      </span>
    ),
    csv: (r) => r.returns ?? 0,
  },
  {
    key: "units_sold",
    label: "Units Sold",
    numeric: true,
    render: (r) => fmtNum(r.units_sold || 0),
    csv: (r) => r.units_sold ?? 0,
  },
  {
    key: "net_sales",
    label: "Net Sales",
    numeric: true,
    render: (r) => (
      <span className="font-semibold">{fmtKESLong(r.net_sales || 0)}</span>
    ),
    csv: (r) => r.net_sales ?? 0,
  },
];

const KpiCard = ({ label, value }) => (
  <div className="bg-white rounded-lg border border-slate-100 shadow-sm p-4">
    <div className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-1">
      {label}
    </div>
    <div className="text-xl font-semibold text-slate-800">{value}</div>
  </div>
);

export default function PartnerBrandsReport() {
  const { applied } = useFilters();
  const { dateFrom, dateTo, countries, channels } = applied;

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [vendor, setVendor] = useState("All");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/partner-brands", {
        params: {
          date_from: dateFrom,
          date_to: dateTo,
          ...(countries?.length ? { country: countries.join(",") } : {}),
          ...(channels?.length ? { locations: channels.join(",") } : {}),
        },
      })
      .then(({ data }) => {
        if (cancelled) return;
        setRows(Array.isArray(data?.rows) ? data.rows : []);
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, countries, channels]);

  const filtered = useMemo(
    () => (vendor === "All" ? rows : rows.filter((r) => r.vendor === vendor)),
    [rows, vendor]
  );

  const totals = useMemo(
    () =>
      filtered.reduce(
        (a, r) => ({
          units:     a.units     + (r.units_sold || 0),
          discount:  a.discount  + (r.discount   || 0),
          returns:   a.returns   + (r.returns     || 0),
          net_sales: a.net_sales + (r.net_sales   || 0),
        }),
        { units: 0, discount: 0, returns: 0, net_sales: 0 }
      ),
    [filtered]
  );

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
            <Storefront weight="duotone" className="text-primary" size={22} />
            Partner Brands Report
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Soko · TIE · Ythera &mdash; {dateFrom} to {dateTo}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <KpiCard label="Units Sold"      value={fmtNum(totals.units)}         />
        <KpiCard label="Discount (KES)"  value={fmtKESLong(totals.discount)}  />
        <KpiCard label="Returns (KES)"    value={fmtKESLong(totals.returns)}   />
        <KpiCard label="Net Sales (KES)" value={fmtKESLong(totals.net_sales)} />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {VENDORS.map((v) => (
          <button
            key={v}
            onClick={() => setVendor(v)}
            className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
              vendor === v
                ? "bg-primary text-white border-primary"
                : "bg-white text-slate-600 border-slate-200 hover:border-primary"
            }`}
          >
            {v}
          </button>
        ))}
        <span className="ml-auto text-sm text-slate-400">
          {fmtNum(filtered.length)} rows
        </span>
      </div>

      {loading ? (
        <Loading label="Loading partner brands report…" />
      ) : error ? (
        <ErrorBox error={error} />
      ) : filtered.length === 0 ? (
        <Empty label="No partner brand sales found for the selected period." />
      ) : (
        <SortableTable
          columns={COLS}
          rows={filtered}
          initialSort={{ key: "net_sales", dir: "desc" }}
          exportName={`partner-brands_${dateFrom}_to_${dateTo}.csv`}
          pageSize={100}
          footerRow={[
            <td key="lbl" className="py-2 px-3 font-semibold text-slate-700 whitespace-nowrap">Totals</td>,
            <td key="v"   className="py-2 px-3" />,
            <td key="sc"  className="py-2 px-3" />,
            <td key="pt"  className="py-2 px-3" />,
            <td key="sku" className="py-2 px-3" />,
            <td key="pr"  className="py-2 px-3 text-right text-slate-400">—</td>,
            <td key="d"   className="py-2 px-3 text-right font-semibold text-slate-700">{fmtKESLong(totals.discount)}</td>,
            <td key="r"   className="py-2 px-3 text-right font-semibold text-rose-600">{fmtKESLong(totals.returns)}</td>,
            <td key="u"   className="py-2 px-3 text-right font-semibold text-slate-700">{fmtNum(totals.units)}</td>,
            <td key="ns"  className="py-2 px-3 text-right font-semibold text-primary">{fmtKESLong(totals.net_sales)}</td>,
          ]}
        />
      )}
    </div>
  );
}
