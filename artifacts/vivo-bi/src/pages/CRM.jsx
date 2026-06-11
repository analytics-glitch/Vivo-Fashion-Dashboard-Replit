import React, { useEffect, useMemo, useState, useCallback } from "react";
import { api, fmtKES, fmtNum, fmtPct, fmtDate } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { useAuth } from "@/lib/auth";
import CountryDot from "@/components/CountryDot";
import { toast } from "sonner";
import {
  MagnifyingGlass,
  UserPlus,
  Plus,
  CheckCircle,
  Crown,
  Ticket as TicketIcon,
  Megaphone,
  Gear,
  ArrowClockwise,
  X,
  Tag as TagIcon,
  Coins,
  ChatText,
  PaperPlaneTilt,
  Trash,
} from "@phosphor-icons/react";

// ---------------------------------------------------------------------------
// CRM — Customer Relationship + Engagement + Loyalty cockpit.
// Single multi-tab page backed by the /api/crm/* endpoints. Brand split
// (vivo | sz) is a first-class filter throughout. No emojis, no flag glyphs —
// countries render as a colored dot + name (CountryDot), brands as a colored
// dot + label (BrandDot). Money is KES.
// ---------------------------------------------------------------------------

const BRAND_META = {
  vivo: { label: "Vivo", color: "#1a5c38" },
  sz: { label: "Shop Zetu", color: "#7c3aed" },
};

const BrandDot = ({ brand, nameOnly = false }) => {
  const m = BRAND_META[brand] || BRAND_META.vivo;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className="inline-block w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: m.color }}
        aria-hidden="true"
      />
      {!nameOnly && <span>{m.label}</span>}
    </span>
  );
};

const TIER_COLORS = {
  VIP: "#1a5c38",
  Gold: "#d97706",
  Silver: "#6b7280",
  Member: "#9ca3af",
};

const Pill = ({ children, color, subtle = false }) => (
  <span
    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
    style={
      subtle
        ? { color, backgroundColor: `${color}1a` }
        : { color: "#fff", backgroundColor: color }
    }
  >
    {children}
  </span>
);

const STATUS_COLORS = {
  open: "#1a5c38",
  in_progress: "#d97706",
  waiting: "#6b7280",
  resolved: "#4b7bec",
  closed: "#9ca3af",
  pending: "#d97706",
  done: "#9ca3af",
  cancelled: "#9ca3af",
  draft: "#9ca3af",
  active: "#1a5c38",
  completed: "#4b7bec",
};

const PRIORITY_COLORS = {
  critical: "#dc2626",
  high: "#d97706",
  normal: "#6b7280",
  low: "#9ca3af",
};

// Force-fresh GET so CRM lists never serve a stale 5-min cache after a write.
const crmGet = (url, params) => api.get(url, { params, forceFresh: true });

const errOf = (e) => e?.response?.data?.detail || e?.message || "Request failed";

// Small native styled controls — robust and consistent with the editorial look.
const inputCls =
  "w-full rounded-md border border-border bg-white px-3 py-2 text-[13px] text-foreground outline-none focus:border-brand";
const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-2 text-[13px] font-semibold text-white hover:bg-brand/90 disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-2 text-[13px] font-semibold text-foreground hover:bg-panel disabled:opacity-50";

const Field = ({ label, children }) => (
  <label className="block space-y-1">
    <span className="text-[11.5px] font-semibold text-muted uppercase tracking-wide">{label}</span>
    {children}
  </label>
);

const Modal = ({ open, onClose, title, children, wide = false }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8">
      <div
        className={`card-white w-full ${wide ? "max-w-4xl" : "max-w-lg"} my-4 p-5 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h3 className="font-sans text-[16px] font-bold tracking-tight text-foreground">{title}</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

// =====================================================================
// Contacts tab
// =====================================================================

const ContactsTab = ({ brand, team, onOpen360 }) => {
  const [q, setQ] = useState("");
  const [segment, setSegment] = useState("");
  const [segments, setSegments] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    crmGet("/crm/customers", { q: q || undefined, brand: brand || undefined, segment: segment || undefined, limit: 100 })
      .then((r) => setRows(r.data?.customers || []))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, [q, brand, segment]);

  useEffect(() => {
    crmGet("/crm/segments").then((r) => setSegments(r.data?.segments || [])).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Contacts"
        subtitle="Search the unified customer base by name, phone or email. Click a row for the 360 view."
        action={
          <button className={btnPrimary} onClick={() => setShowCreate(true)}>
            <UserPlus size={15} /> New contact
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[260px] flex-1">
          <MagnifyingGlass size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className={`${inputCls} pl-9`}
            placeholder="Search name, phone or email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className={`${inputCls} w-auto`} value={segment} onChange={(e) => setSegment(e.target.value)}>
          <option value="">All segments</option>
          {segments.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label} ({fmtNum(s.count)})
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <Loading label="Searching contacts…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : rows.length === 0 ? (
        <Empty label="No contacts match your search." />
      ) : (
        <div className="card-white overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-semibold">Customer</th>
                <th className="px-3 py-2 font-semibold">Brand</th>
                <th className="px-3 py-2 font-semibold">Market</th>
                <th className="px-3 py-2 font-semibold text-right">Orders</th>
                <th className="px-3 py-2 font-semibold text-right">Spend</th>
                <th className="px-3 py-2 font-semibold">Last order</th>
                <th className="px-3 py-2 font-semibold">Loyalty</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.customer_id}
                  className="cursor-pointer border-b border-border/60 hover:bg-panel/60"
                  onClick={() => onOpen360(c.customer_id)}
                >
                  <td className="px-3 py-2">
                    <div className="font-semibold text-foreground">{c.name || "Unnamed contact"}</div>
                    <div className="text-[11.5px] text-muted">
                      {c.phone || c.email || c.customer_id}
                      {c.is_manual && <span className="ml-2 text-[10px] text-brand">manual</span>}
                    </div>
                    {c.tags?.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {c.tags.map((t) => (
                          <Pill key={t.id} color={t.color || "#1a5c38"} subtle>
                            {t.name}
                          </Pill>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2"><BrandDot brand={c.brand_code} /></td>
                  <td className="px-3 py-2">{c.country ? <CountryDot country={c.country} /> : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(c.total_orders)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtKES(c.total_spend_kes)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{c.last_order_date ? fmtDate(c.last_order_date) : "—"}</td>
                  <td className="px-3 py-2">
                    {c.tier ? (
                      <Pill color={TIER_COLORS[c.tier] || "#6b7280"} subtle>
                        {c.tier} · {fmtNum(c.points_balance || 0)} pts
                      </Pill>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateContactModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        brand={brand}
        onCreated={(cid) => {
          setShowCreate(false);
          load();
          onOpen360(cid);
        }}
      />
    </div>
  );
};

const CreateContactModal = ({ open, onClose, brand, onCreated }) => {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setForm({ brand_code: brand || "vivo", consent_marketing: false, consent_data_processing: false });
  }, [open, brand]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => {
    if (!form.first_name && !form.last_name) {
      toast.error("A first or last name is required");
      return;
    }
    setSaving(true);
    api
      .post("/crm/customers", form)
      .then((r) => {
        toast.success("Contact created");
        onCreated(r.data?.customer_id);
      })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setSaving(false));
  };
  return (
    <Modal open={open} onClose={onClose} title="New manual contact">
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name">
          <input className={inputCls} value={form.first_name || ""} onChange={(e) => set("first_name", e.target.value)} />
        </Field>
        <Field label="Last name">
          <input className={inputCls} value={form.last_name || ""} onChange={(e) => set("last_name", e.target.value)} />
        </Field>
        <Field label="Phone">
          <input className={inputCls} value={form.phone || ""} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="Email">
          <input className={inputCls} value={form.email || ""} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Brand">
          <select className={inputCls} value={form.brand_code || "vivo"} onChange={(e) => set("brand_code", e.target.value)}>
            <option value="vivo">Vivo</option>
            <option value="sz">Shop Zetu</option>
          </select>
        </Field>
        <Field label="Preferred size">
          <input className={inputCls} value={form.preferred_size || ""} onChange={(e) => set("preferred_size", e.target.value)} />
        </Field>
        <div className="col-span-2 flex items-center gap-4 pt-1">
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={!!form.consent_marketing} onChange={(e) => set("consent_marketing", e.target.checked)} />
            Marketing consent
          </label>
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={!!form.consent_data_processing} onChange={(e) => set("consent_data_processing", e.target.checked)} />
            Data-processing consent
          </label>
        </div>
        <div className="col-span-2">
          <Field label="Notes">
            <textarea className={inputCls} rows={2} value={form.notes || ""} onChange={(e) => set("notes", e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={submit} disabled={saving}>
          {saving ? "Saving…" : "Create contact"}
        </button>
      </div>
    </Modal>
  );
};

// =====================================================================
// Customer 360 modal
// =====================================================================

const Customer360 = ({ customerId, isAdmin, team, onClose, onChanged }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("activity");

  const load = useCallback(() => {
    setLoading(true);
    crmGet(`/crm/customers/${encodeURIComponent(customerId)}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  const logInteraction = (type) => {
    const notes = window.prompt(`Log ${type} — outcome / notes:`);
    if (notes === null) return;
    api
      .post(`/crm/customers/${encodeURIComponent(customerId)}/interactions`, { type, notes, outcome: "logged" })
      .then(() => { toast.success("Interaction logged"); load(); })
      .catch((e) => toast.error(errOf(e)));
  };

  const enrol = () => {
    api
      .post(`/crm/loyalty/${encodeURIComponent(customerId)}/enrol`)
      .then((r) => { toast.success(`Enrolled — ${r.data?.tier}`); load(); onChanged?.(); })
      .catch((e) => toast.error(errOf(e)));
  };

  const adjust = () => {
    const v = window.prompt("Points adjustment (e.g. 500 or -100):");
    if (!v) return;
    const reason = window.prompt("Reason:") || "admin";
    api
      .post(`/crm/loyalty/${encodeURIComponent(customerId)}/adjust`, { points_change: parseInt(v, 10), reason })
      .then((r) => { toast.success(`Balance: ${fmtNum(r.data?.points_balance)} pts`); load(); onChanged?.(); })
      .catch((e) => toast.error(errOf(e)));
  };

  const redeem = () => {
    const v = window.prompt("Points to redeem:");
    if (!v) return;
    api
      .post(`/crm/loyalty/${encodeURIComponent(customerId)}/redeem`, { points: parseInt(v, 10) })
      .then((r) => { toast.success(`Code ${r.data?.discount_code} — ${fmtKES(r.data?.kes_value)}`); load(); onChanged?.(); })
      .catch((e) => toast.error(errOf(e)));
  };

  const p = data?.profile;
  const loyalty = data?.loyalty;
  const enrolment = loyalty?.enrolment;

  return (
    <Modal open onClose={onClose} wide title={p ? p.name || "Customer 360" : "Customer 360"}>
      {loading ? (
        <Loading label="Loading customer…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : !data ? (
        <Empty label="Customer not found." />
      ) : (
        <div className="space-y-4">
          {/* Header / profile */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <div className="text-[11px] uppercase text-muted">Brand</div>
              <BrandDot brand={p.brand_code} />
            </div>
            <div>
              <div className="text-[11px] uppercase text-muted">Market</div>
              {p.country ? <CountryDot country={p.country} /> : "—"}
            </div>
            <div>
              <div className="text-[11px] uppercase text-muted">Lifetime spend</div>
              <div className="font-semibold">{fmtKES(p.total_spend_kes)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-muted">Orders</div>
              <div className="font-semibold">{fmtNum(p.total_orders)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-muted">Phone</div>
              <div>{p.phone || "—"}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-muted">Email</div>
              <div className="truncate">{p.email || "—"}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-muted">First order</div>
              <div>{p.first_order_date ? fmtDate(p.first_order_date) : "—"}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-muted">Last order</div>
              <div>{p.last_order_date ? fmtDate(p.last_order_date) : "—"}</div>
            </div>
          </div>

          {/* Loyalty strip */}
          <div className="flex flex-wrap items-center gap-3 rounded-md bg-panel/60 px-3 py-2">
            <Crown size={16} className="text-brand" />
            {enrolment ? (
              <>
                <Pill color={TIER_COLORS[enrolment.tier] || "#6b7280"}>{enrolment.tier}</Pill>
                <span className="text-[13px] font-semibold">{fmtNum(enrolment.points_balance)} pts</span>
                <span className="text-[12px] text-muted">lifetime {fmtNum(enrolment.points_lifetime)}</span>
              </>
            ) : (
              <span className="text-[13px] text-muted">Not enrolled in loyalty</span>
            )}
            <div className="ml-auto flex gap-2">
              {!enrolment ? (
                <button className={btnGhost} onClick={enrol}>Enrol</button>
              ) : (
                <>
                  <button className={btnGhost} onClick={enrol}>Re-evaluate tier</button>
                  {isAdmin && <button className={btnGhost} onClick={adjust}>Adjust</button>}
                  <button className={btnGhost} onClick={redeem}>Redeem</button>
                </>
              )}
            </div>
          </div>

          {/* Sub-tabs */}
          <div className="flex gap-1 border-b border-border text-[13px]">
            {[
              ["activity", "Activity"],
              ["transactions", `Transactions (${data.transactions?.length || 0})`],
              ["tasks", `Tasks (${data.tasks?.length || 0})`],
              ["tickets", `Tickets (${data.tickets?.length || 0})`],
              ["loyalty", "Loyalty ledger"],
            ].map(([k, lbl]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-3 py-2 font-semibold ${tab === k ? "border-b-2 border-brand text-brand" : "text-muted"}`}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="max-h-[40vh] overflow-y-auto">
            {tab === "activity" && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <button className={btnGhost} onClick={() => logInteraction("call")}>Log call</button>
                  <button className={btnGhost} onClick={() => logInteraction("whatsapp")}>Log WhatsApp</button>
                  <button className={btnGhost} onClick={() => logInteraction("note")}>Add note</button>
                </div>
                {data.interactions?.length ? (
                  <ul className="space-y-2">
                    {data.interactions.map((it) => (
                      <li key={it.id} className="rounded-md border border-border/60 p-2 text-[12.5px]">
                        <div className="flex justify-between">
                          <span className="font-semibold capitalize">{it.type}</span>
                          <span className="text-muted">{fmtDate(it.created_at)}</span>
                        </div>
                        {it.notes && <div className="mt-0.5 text-foreground">{it.notes}</div>}
                        <div className="mt-0.5 text-[11px] text-muted">{it.user_name}</div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty label="No interactions logged yet." />
                )}
              </div>
            )}

            {tab === "transactions" && (
              data.transactions?.length ? (
                <table className="min-w-full text-[12.5px]">
                  <thead>
                    <tr className="text-left text-muted">
                      <th className="px-2 py-1">Order</th>
                      <th className="px-2 py-1">Date</th>
                      <th className="px-2 py-1">Location</th>
                      <th className="px-2 py-1 text-right">Units</th>
                      <th className="px-2 py-1 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.transactions.map((t) => (
                      <tr key={t.order_id} className="border-t border-border/50">
                        <td className="px-2 py-1">{t.order_id}</td>
                        <td className="px-2 py-1 whitespace-nowrap">{fmtDate(t.sale_date)}</td>
                        <td className="px-2 py-1">{t.pos_location || "—"}</td>
                        <td className="px-2 py-1 text-right">{fmtNum(t.units)}</td>
                        <td className="px-2 py-1 text-right">{fmtKES(t.amount_kes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty label="No transactions on record." />
              )
            )}

            {tab === "tasks" && (
              data.tasks?.length ? (
                <ul className="space-y-2">
                  {data.tasks.map((t) => (
                    <li key={t.id} className="rounded-md border border-border/60 p-2 text-[12.5px]">
                      <div className="flex justify-between">
                        <span className="font-semibold">{t.title}</span>
                        <Pill color={STATUS_COLORS[t.status] || "#6b7280"} subtle>{t.status}</Pill>
                      </div>
                      {t.due_date && <div className="text-[11px] text-muted">Due {fmtDate(t.due_date)}</div>}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty label="No tasks for this customer." />
              )
            )}

            {tab === "tickets" && (
              data.tickets?.length ? (
                <ul className="space-y-2">
                  {data.tickets.map((t) => (
                    <li key={t.id} className="rounded-md border border-border/60 p-2 text-[12.5px]">
                      <div className="flex justify-between">
                        <span className="font-semibold">{t.ticket_number} · {t.subject}</span>
                        <Pill color={STATUS_COLORS[t.status] || "#6b7280"} subtle>{t.status}</Pill>
                      </div>
                      <div className="text-[11px] text-muted">{t.inbound_channel} · {fmtDate(t.created_at)}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty label="No tickets for this customer." />
              )
            )}

            {tab === "loyalty" && (
              <div className="space-y-3">
                <div>
                  <div className="mb-1 text-[11px] uppercase text-muted">Points ledger</div>
                  {loyalty?.ledger?.length ? (
                    <ul className="space-y-1">
                      {loyalty.ledger.map((l) => (
                        <li key={l.id} className="flex justify-between text-[12.5px]">
                          <span>{l.reason}</span>
                          <span className={l.points_change >= 0 ? "text-brand" : "text-danger"}>
                            {l.points_change >= 0 ? "+" : ""}{fmtNum(l.points_change)} → {fmtNum(l.balance_after)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty label="No ledger entries." />
                  )}
                </div>
                <div>
                  <div className="mb-1 text-[11px] uppercase text-muted">Redemptions</div>
                  {loyalty?.redemptions?.length ? (
                    <ul className="space-y-1">
                      {loyalty.redemptions.map((r) => (
                        <li key={r.id} className="flex justify-between text-[12.5px]">
                          <span className="font-mono">{r.discount_code}</span>
                          <span>{fmtNum(r.points_redeemed)} pts · {fmtKES(r.kes_value)} · {r.code_status}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty label="No redemptions." />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};

// =====================================================================
// Tasks tab
// =====================================================================

const TasksTab = ({ brand, team }) => {
  const [status, setStatus] = useState("open");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    crmGet("/crm/tasks", { status: status || undefined, brand: brand || undefined })
      .then((r) => setRows(r.data?.tasks || []))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, [status, brand]);

  useEffect(() => { load(); }, [load]);

  const patch = (id, body) =>
    api.patch(`/crm/tasks/${id}`, body).then(() => { toast.success("Task updated"); load(); }).catch((e) => toast.error(errOf(e)));

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Follow-up tasks"
        subtitle="Shared team queue. Assign, prioritise and close the loop with logged outcomes."
        action={<button className={btnPrimary} onClick={() => setShowCreate(true)}><Plus size={15} /> New task</button>}
      />
      <div className="flex gap-2">
        {["open", "pending", "done", ""].map((s) => (
          <button
            key={s || "all"}
            onClick={() => setStatus(s)}
            className={`rounded-md px-3 py-1.5 text-[12.5px] font-semibold ${status === s ? "bg-brand text-white" : "border border-border bg-white text-muted"}`}
          >
            {s ? s[0].toUpperCase() + s.slice(1) : "All"}
          </button>
        ))}
      </div>

      {loading ? (
        <Loading label="Loading tasks…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : rows.length === 0 ? (
        <Empty label="No tasks in this view." />
      ) : (
        <div className="card-white overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-semibold">Task</th>
                <th className="px-3 py-2 font-semibold">Priority</th>
                <th className="px-3 py-2 font-semibold">Assignee</th>
                <th className="px-3 py-2 font-semibold">Due</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b border-border/60">
                  <td className="px-3 py-2">
                    <div className="font-semibold">{t.title}</div>
                    {t.description && <div className="text-[11.5px] text-muted">{t.description}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <Pill color={PRIORITY_COLORS[t.priority] || "#6b7280"} subtle>{t.priority}</Pill>
                  </td>
                  <td className="px-3 py-2">{t.assignee_name || <span className="text-muted">Unassigned</span>}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{t.due_date ? fmtDate(t.due_date) : "—"}</td>
                  <td className="px-3 py-2"><Pill color={STATUS_COLORS[t.status] || "#6b7280"} subtle>{t.status}</Pill></td>
                  <td className="px-3 py-2 text-right">
                    {t.status !== "done" && t.status !== "cancelled" && (
                      <button className={btnGhost} onClick={() => patch(t.id, { status: "done" })}>
                        <CheckCircle size={14} /> Done
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateTaskModal open={showCreate} onClose={() => setShowCreate(false)} brand={brand} team={team} onCreated={() => { setShowCreate(false); load(); }} />
    </div>
  );
};

const CreateTaskModal = ({ open, onClose, brand, team, onCreated }) => {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setForm({ priority: "normal", brand_code: brand || "vivo" }); }, [open, brand]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => {
    if (!form.title) { toast.error("Task title is required"); return; }
    setSaving(true);
    api.post("/crm/tasks", form)
      .then(() => { toast.success("Task created"); onCreated(); })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setSaving(false));
  };
  return (
    <Modal open={open} onClose={onClose} title="New follow-up task">
      <div className="space-y-3">
        <Field label="Title">
          <input className={inputCls} value={form.title || ""} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="Description">
          <textarea className={inputCls} rows={2} value={form.description || ""} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer ID (optional)">
            <input className={inputCls} value={form.customer_id || ""} onChange={(e) => set("customer_id", e.target.value)} />
          </Field>
          <Field label="Due date">
            <input type="date" className={inputCls} value={form.due_date || ""} onChange={(e) => set("due_date", e.target.value)} />
          </Field>
          <Field label="Priority">
            <select className={inputCls} value={form.priority || "normal"} onChange={(e) => set("priority", e.target.value)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </Field>
          <Field label="Assignee">
            <select className={inputCls} value={form.assignee_user_id || ""} onChange={(e) => set("assignee_user_id", e.target.value)}>
              <option value="">Unassigned</option>
              {team.map((m) => <option key={m.user_id} value={m.user_id}>{m.name || m.email}</option>)}
            </select>
          </Field>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={submit} disabled={saving}>{saving ? "Saving…" : "Create task"}</button>
      </div>
    </Modal>
  );
};

// =====================================================================
// Tickets tab
// =====================================================================

const TicketsTab = ({ brand, team }) => {
  const [status, setStatus] = useState("open");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    crmGet("/crm/tickets", { status: status || undefined, brand: brand || undefined })
      .then((r) => setRows(r.data?.tickets || []))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, [status, brand]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Service tickets"
        subtitle="Internal service desk with channel-based SLA timers and CSAT capture."
        action={<button className={btnPrimary} onClick={() => setShowCreate(true)}><Plus size={15} /> New ticket</button>}
      />
      <div className="flex gap-2">
        {["open", "resolved", "closed", ""].map((s) => (
          <button
            key={s || "all"}
            onClick={() => setStatus(s)}
            className={`rounded-md px-3 py-1.5 text-[12.5px] font-semibold ${status === s ? "bg-brand text-white" : "border border-border bg-white text-muted"}`}
          >
            {s ? s[0].toUpperCase() + s.slice(1) : "All"}
          </button>
        ))}
      </div>

      {loading ? (
        <Loading label="Loading tickets…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : rows.length === 0 ? (
        <Empty label="No tickets in this view." />
      ) : (
        <div className="card-white overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-semibold">Ticket</th>
                <th className="px-3 py-2 font-semibold">Channel</th>
                <th className="px-3 py-2 font-semibold">Priority</th>
                <th className="px-3 py-2 font-semibold">Assigned</th>
                <th className="px-3 py-2 font-semibold">SLA</th>
                <th className="px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="cursor-pointer border-b border-border/60 hover:bg-panel/60" onClick={() => setDetailId(t.id)}>
                  <td className="px-3 py-2">
                    <div className="font-semibold">{t.ticket_number}</div>
                    <div className="text-[11.5px] text-muted">{t.subject}</div>
                    {t.customer_name && <div className="text-[11px] text-muted">{t.customer_name}</div>}
                  </td>
                  <td className="px-3 py-2 capitalize">{(t.inbound_channel || "").replace("_", " ")}</td>
                  <td className="px-3 py-2"><Pill color={PRIORITY_COLORS[t.priority] || "#6b7280"} subtle>{t.priority}</Pill></td>
                  <td className="px-3 py-2">{t.assigned_to_name || <span className="text-muted">—</span>}</td>
                  <td className="px-3 py-2">
                    {t.sla_breached ? (
                      <Pill color="#dc2626" subtle>Breached</Pill>
                    ) : t.sla_overdue ? (
                      <Pill color="#dc2626" subtle>Overdue</Pill>
                    ) : (
                      <Pill color="#1a5c38" subtle>On track</Pill>
                    )}
                  </td>
                  <td className="px-3 py-2"><Pill color={STATUS_COLORS[t.status] || "#6b7280"} subtle>{t.status}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateTicketModal open={showCreate} onClose={() => setShowCreate(false)} brand={brand} team={team} onCreated={() => { setShowCreate(false); load(); }} />
      {detailId && <TicketDetail ticketId={detailId} team={team} onClose={() => setDetailId(null)} onChanged={load} />}
    </div>
  );
};

const CHANNELS = ["whatsapp", "meta", "tiktok", "email", "in_store", "phone"];

const CreateTicketModal = ({ open, onClose, brand, team, onCreated }) => {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setForm({ inbound_channel: "whatsapp", priority: "normal", brand_code: brand || "vivo" }); }, [open, brand]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => {
    if (!form.subject) { toast.error("Subject is required"); return; }
    setSaving(true);
    api.post("/crm/tickets", form)
      .then((r) => { toast.success(`Ticket ${r.data?.ticket_number} created`); onCreated(); })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setSaving(false));
  };
  return (
    <Modal open={open} onClose={onClose} title="New service ticket">
      <div className="space-y-3">
        <Field label="Subject">
          <input className={inputCls} value={form.subject || ""} onChange={(e) => set("subject", e.target.value)} />
        </Field>
        <Field label="Description">
          <textarea className={inputCls} rows={2} value={form.description || ""} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer ID (optional)">
            <input className={inputCls} value={form.customer_id || ""} onChange={(e) => set("customer_id", e.target.value)} />
          </Field>
          <Field label="Issue category">
            <input className={inputCls} value={form.issue_category || ""} onChange={(e) => set("issue_category", e.target.value)} />
          </Field>
          <Field label="Inbound channel">
            <select className={inputCls} value={form.inbound_channel} onChange={(e) => set("inbound_channel", e.target.value)}>
              {CHANNELS.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select className={inputCls} value={form.priority} onChange={(e) => set("priority", e.target.value)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </Field>
          <Field label="Assign to">
            <select className={inputCls} value={form.assigned_to || ""} onChange={(e) => set("assigned_to", e.target.value)}>
              <option value="">Unassigned</option>
              {team.map((m) => <option key={m.user_id} value={m.user_id}>{m.name || m.email}</option>)}
            </select>
          </Field>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={submit} disabled={saving}>{saving ? "Saving…" : "Create ticket"}</button>
      </div>
    </Modal>
  );
};

const TicketDetail = ({ ticketId, team, onClose, onChanged }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    crmGet(`/crm/tickets/${ticketId}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, [ticketId]);

  useEffect(() => { load(); }, [load]);

  const patch = (body) =>
    api.patch(`/crm/tickets/${ticketId}`, body).then(() => { toast.success("Ticket updated"); load(); onChanged?.(); }).catch((e) => toast.error(errOf(e)));

  const send = () => {
    if (!msg.trim()) return;
    api.post(`/crm/tickets/${ticketId}/messages`, { body: msg, direction: "outbound" })
      .then(() => { setMsg(""); load(); })
      .catch((e) => toast.error(errOf(e)));
  };

  const t = data?.ticket;
  return (
    <Modal open onClose={onClose} wide title={t ? `${t.ticket_number} · ${t.subject}` : "Ticket"}>
      {loading ? (
        <Loading label="Loading ticket…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : !t ? (
        <Empty label="Ticket not found." />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Field label="Status">
              <select className={inputCls} value={t.status} onChange={(e) => patch({ status: e.target.value })}>
                {["open", "in_progress", "waiting", "resolved", "closed"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select className={inputCls} value={t.priority} onChange={(e) => patch({ priority: e.target.value })}>
                {["low", "normal", "high", "critical"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Assigned to">
              <select className={inputCls} value={t.assigned_to || ""} onChange={(e) => patch({ assigned_to: e.target.value })}>
                <option value="">Unassigned</option>
                {team.map((m) => <option key={m.user_id} value={m.user_id}>{m.name || m.email}</option>)}
              </select>
            </Field>
            {(t.status === "resolved" || t.status === "closed") && (
              <Field label="CSAT (1–5)">
                <select className={inputCls} value={t.csat_score || ""} onChange={(e) => patch({ csat_score: e.target.value })}>
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
            )}
          </div>

          <div className="text-[12px] text-muted">
            Channel {t.inbound_channel} · created {fmtDate(t.created_at)} · SLA target {t.sla_target_minutes} min
            {t.sla_breached && <span className="ml-2 font-semibold text-danger">SLA breached</span>}
          </div>

          <div className="max-h-[35vh] space-y-2 overflow-y-auto rounded-md bg-panel/50 p-3">
            {data.messages?.length ? data.messages.map((m) => (
              <div key={m.id} className={`rounded-md p-2 text-[12.5px] ${m.direction === "inbound" ? "bg-white" : m.direction === "internal" ? "bg-amber-50" : "bg-brand/10"}`}>
                <div className="flex justify-between text-[11px] text-muted">
                  <span className="capitalize">{m.direction} · {m.sender_name}</span>
                  <span>{fmtDate(m.created_at)}</span>
                </div>
                <div className="mt-0.5">{m.body}</div>
              </div>
            )) : <Empty label="No messages yet." />}
          </div>

          <div className="flex gap-2">
            <input className={inputCls} placeholder="Type a reply…" value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
            <button className={btnPrimary} onClick={send}>Send</button>
          </div>
        </div>
      )}
    </Modal>
  );
};

// =====================================================================
// Campaigns tab
// =====================================================================

const CampaignsTab = ({ brand }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    crmGet("/crm/campaigns", { brand: brand || undefined })
      .then((r) => setRows(r.data?.campaigns || []))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, [brand]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Campaigns"
        subtitle="Track sends and responses for manual outreach across WhatsApp, email and social."
        action={<button className={btnPrimary} onClick={() => setShowCreate(true)}><Plus size={15} /> New campaign</button>}
      />
      {loading ? (
        <Loading label="Loading campaigns…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : rows.length === 0 ? (
        <Empty label="No campaigns yet." />
      ) : (
        <div className="card-white overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-semibold">Campaign</th>
                <th className="px-3 py-2 font-semibold">Brand</th>
                <th className="px-3 py-2 font-semibold">Channel</th>
                <th className="px-3 py-2 font-semibold text-right">Members</th>
                <th className="px-3 py-2 font-semibold text-right">Sent</th>
                <th className="px-3 py-2 font-semibold text-right">Responses</th>
                <th className="px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="cursor-pointer border-b border-border/60 hover:bg-panel/60" onClick={() => setDetailId(c.id)}>
                  <td className="px-3 py-2 font-semibold">{c.name}</td>
                  <td className="px-3 py-2"><BrandDot brand={c.brand_code} /></td>
                  <td className="px-3 py-2 capitalize">{c.channel || "—"}</td>
                  <td className="px-3 py-2 text-right">{fmtNum(c.members)}</td>
                  <td className="px-3 py-2 text-right">{fmtNum(c.sent)}</td>
                  <td className="px-3 py-2 text-right">
                    {fmtNum(c.responses)}
                    {c.sent > 0 && <span className="ml-1 text-[11px] text-muted">({fmtPct((c.responses / c.sent) * 100)})</span>}
                  </td>
                  <td className="px-3 py-2"><Pill color={STATUS_COLORS[c.status] || "#6b7280"} subtle>{c.status}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateCampaignModal open={showCreate} onClose={() => setShowCreate(false)} brand={brand} onCreated={() => { setShowCreate(false); load(); }} />
      {detailId && <CampaignDetail campaignId={detailId} onClose={() => setDetailId(null)} onChanged={load} />}
    </div>
  );
};

const CreateCampaignModal = ({ open, onClose, brand, onCreated }) => {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setForm({ channel: "whatsapp", status: "draft", brand_code: brand || "vivo" }); }, [open, brand]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => {
    if (!form.name) { toast.error("Campaign name is required"); return; }
    setSaving(true);
    api.post("/crm/campaigns", form)
      .then(() => { toast.success("Campaign created"); onCreated(); })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setSaving(false));
  };
  return (
    <Modal open={open} onClose={onClose} title="New campaign">
      <div className="space-y-3">
        <Field label="Name">
          <input className={inputCls} value={form.name || ""} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Channel">
            <select className={inputCls} value={form.channel} onChange={(e) => set("channel", e.target.value)}>
              {["whatsapp", "email", "sms", "meta", "tiktok"].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Brand">
            <select className={inputCls} value={form.brand_code || "vivo"} onChange={(e) => set("brand_code", e.target.value)}>
              <option value="vivo">Vivo</option>
              <option value="sz">Shop Zetu</option>
            </select>
          </Field>
        </div>
        <Field label="Description">
          <textarea className={inputCls} rows={2} value={form.description || ""} onChange={(e) => set("description", e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={submit} disabled={saving}>{saving ? "Saving…" : "Create campaign"}</button>
      </div>
    </Modal>
  );
};

const CampaignDetail = ({ campaignId, onClose, onChanged }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    crmGet(`/crm/campaigns/${campaignId}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  const markAllSent = () =>
    api.post(`/crm/campaigns/${campaignId}/mark-sent`, {}).then(() => { toast.success("Marked sent"); load(); onChanged?.(); }).catch((e) => toast.error(errOf(e)));

  const memberPatch = (mid, body) =>
    api.patch(`/crm/campaigns/${campaignId}/members/${mid}`, body).then(() => load()).catch((e) => toast.error(errOf(e)));

  const c = data?.campaign;
  return (
    <Modal open onClose={onClose} wide title={c ? c.name : "Campaign"}>
      {loading ? (
        <Loading label="Loading campaign…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : !c ? (
        <Empty label="Campaign not found." />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-[12.5px] text-muted">
            <BrandDot brand={c.brand_code} /> · <span className="capitalize">{c.channel}</span> ·{" "}
            <Pill color={STATUS_COLORS[c.status] || "#6b7280"} subtle>{c.status}</Pill>
            <button className={`${btnGhost} ml-auto`} onClick={markAllSent}>Mark all sent</button>
          </div>
          {c.description && <p className="text-[13px]">{c.description}</p>}
          <div className="max-h-[45vh] overflow-y-auto">
            {data.members?.length ? (
              <table className="min-w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="px-2 py-1">Customer</th>
                    <th className="px-2 py-1">Contact</th>
                    <th className="px-2 py-1">Send</th>
                    <th className="px-2 py-1">Response</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((m) => (
                    <tr key={m.id} className="border-t border-border/50">
                      <td className="px-2 py-1">{m.name || m.customer_id}</td>
                      <td className="px-2 py-1">{m.phone || m.email || "—"}</td>
                      <td className="px-2 py-1">
                        {m.send_status === "sent" ? (
                          <Pill color="#1a5c38" subtle>sent</Pill>
                        ) : (
                          <button className="text-brand underline" onClick={() => memberPatch(m.id, { send_status: "sent" })}>mark sent</button>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        {m.responded ? (
                          <Pill color="#4b7bec" subtle>responded</Pill>
                        ) : (
                          <button className="text-brand underline" onClick={() => memberPatch(m.id, { responded: true })}>mark responded</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty label="No members yet. Add contacts to this campaign from the Contacts tab (coming soon) or via the API." />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};

// =====================================================================
// Loyalty tab
// =====================================================================

const LoyaltyTab = ({ isAdmin, onOpen360 }) => {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lookup, setLookup] = useState("");
  const [results, setResults] = useState([]);
  const [earnCode, setEarnCode] = useState("");
  const [earnAmount, setEarnAmount] = useState("");
  const [earning, setEarning] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemInfo, setRedeemInfo] = useState(null);
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [redeemStore, setRedeemStore] = useState("");
  const [report, setReport] = useState(null);
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");

  const loadReport = useCallback(() => {
    const params = reportFrom && reportTo ? { date_from: reportFrom, date_to: reportTo } : {};
    crmGet("/crm/loyalty/redemptions/report", params)
      .then((r) => setReport(r.data))
      .catch((e) => toast.error(errOf(e)));
  }, [reportFrom, reportTo]);

  const load = useCallback(() => {
    setLoading(true);
    crmGet("/crm/loyalty/summary")
      .then((r) => setSummary(r.data))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
    loadReport();
  }, [loadReport]);

  useEffect(() => { load(); }, [load]);

  const search = () => {
    if (!lookup.trim()) return;
    crmGet("/crm/customers", { q: lookup, limit: 20 }).then((r) => setResults(r.data?.customers || [])).catch((e) => toast.error(errOf(e)));
  };

  const awardPoints = () => {
    const code = earnCode.trim();
    const amount = Number(earnAmount);
    if (!code) { toast.error("Scan or enter a membership code"); return; }
    if (!amount || amount <= 0) { toast.error("Enter a valid purchase amount"); return; }
    setEarning(true);
    api.post("/crm/loyalty/earn", { membership_code: code, amount_kes: amount })
      .then((r) => {
        const d = r.data || {};
        toast.success(`${d.member_name || "Member"}: +${fmtNum(d.points_awarded || 0)} pts (balance ${fmtNum(d.points_balance || 0)})`);
        setEarnCode("");
        setEarnAmount("");
        load();
      })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setEarning(false));
  };

  const redeemLookup = () => {
    const code = redeemCode.trim();
    if (!code) { toast.error("Scan or enter a redemption code"); return; }
    setRedeemBusy(true);
    setRedeemInfo(null);
    api.post("/crm/loyalty/redeem-code/lookup", { code })
      .then((r) => setRedeemInfo(r.data || null))
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setRedeemBusy(false));
  };

  const redeemApply = () => {
    const code = (redeemInfo?.discount_code || redeemCode).trim();
    if (!code) return;
    setRedeemBusy(true);
    api.post("/crm/loyalty/redeem-code/apply", { code, used_store_id: redeemStore.trim() || undefined })
      .then((r) => {
        const d = r.data || {};
        toast.success(`Applied ${fmtKES(d.kes_value || 0)} discount for ${d.member_name || "member"}`);
        setRedeemCode("");
        setRedeemInfo(null);
        setRedeemStore("");
        load();
      })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setRedeemBusy(false));
  };

  const recalc = () =>
    api.post("/crm/loyalty/recalc-tiers", {}).then((r) => { toast.success(`Re-evaluated ${r.data?.evaluated} members`); load(); }).catch((e) => toast.error(errOf(e)));

  const tiers = ["VIP", "Gold", "Silver", "Member"];

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Loyalty"
        subtitle="Append-only points ledger, rolling-12-month spend tiers and redemption codes."
        action={isAdmin && <button className={btnGhost} onClick={recalc}><ArrowClockwise size={14} /> Re-evaluate tiers</button>}
      />

      <div className="card-white p-4">
        <div className="mb-2 text-[12px] font-semibold uppercase text-muted">Award points (scan code)</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className={inputCls}
            placeholder="Scan or enter membership code…"
            value={earnCode}
            onChange={(e) => setEarnCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && awardPoints()}
          />
          <input
            className={inputCls}
            type="number"
            min="0"
            placeholder="Purchase amount (KES)"
            value={earnAmount}
            onChange={(e) => setEarnAmount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && awardPoints()}
          />
          <button className={btnPrimary} onClick={awardPoints} disabled={earning}>
            <Coins size={14} /> {earning ? "Awarding…" : "Award points"}
          </button>
        </div>
        <div className="mt-2 text-[11.5px] text-muted">Earns points from the purchase amount at the configured earn rate. Updates the member's balance and tier.</div>
      </div>

      <div className="card-white p-4">
        <div className="mb-2 text-[12px] font-semibold uppercase text-muted">Redeem code (at till)</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className={inputCls}
            placeholder="Scan or enter redemption code (e.g. VFG-XXXXXXXX)…"
            value={redeemCode}
            onChange={(e) => { setRedeemCode(e.target.value); setRedeemInfo(null); }}
            onKeyDown={(e) => e.key === "Enter" && redeemLookup()}
          />
          <input
            className={inputCls}
            placeholder="Store ID (optional)"
            value={redeemStore}
            onChange={(e) => setRedeemStore(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && redeemLookup()}
          />
          <button className={btnGhost} onClick={redeemLookup} disabled={redeemBusy}>
            <MagnifyingGlass size={14} /> {redeemBusy && !redeemInfo ? "Checking…" : "Validate"}
          </button>
        </div>
        {redeemInfo && (
          <div className="mt-3 rounded-md border border-border/60 bg-panel/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[14px] font-semibold">{redeemInfo.member_name || "Member"}</div>
                <div className="text-[12px] text-muted">
                  {redeemInfo.discount_code} · {fmtNum(redeemInfo.points_redeemed || 0)} pts ·{" "}
                  <span className="font-semibold text-ink">{fmtKES(redeemInfo.kes_value || 0)} discount</span>
                </div>
              </div>
              {redeemInfo.redeemable ? (
                <button className={btnPrimary} onClick={redeemApply} disabled={redeemBusy}>
                  <TicketIcon size={14} /> {redeemBusy ? "Applying…" : "Apply discount"}
                </button>
              ) : (
                <span className="rounded-full bg-rose-100 px-3 py-1 text-[12px] font-semibold text-rose-700">
                  Code already {redeemInfo.code_status}
                  {redeemInfo.used_at ? ` · ${fmtDate(redeemInfo.used_at)}` : ""}
                </span>
              )}
            </div>
          </div>
        )}
        <div className="mt-2 text-[11.5px] text-muted">Validate the member's redemption code, then apply it at checkout. Each code can only be used once.</div>
      </div>

      {loading ? (
        <Loading label="Loading loyalty summary…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : summary && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="card-white p-3">
              <div className="text-[11px] uppercase text-muted">Members</div>
              <div className="text-[20px] font-bold">{fmtNum(summary.total_members)}</div>
            </div>
            <div className="card-white p-3">
              <div className="text-[11px] uppercase text-muted">Points outstanding</div>
              <div className="text-[20px] font-bold">{fmtNum(summary.total_points_outstanding)}</div>
            </div>
            <div className="card-white p-3">
              <div className="text-[11px] uppercase text-muted">Open codes</div>
              <div className="text-[20px] font-bold">{fmtNum(summary.redemptions?.open_codes || 0)}</div>
            </div>
            <div className="card-white p-3">
              <div className="text-[11px] uppercase text-muted">Used codes</div>
              <div className="text-[20px] font-bold">{fmtNum(summary.redemptions?.used_codes || 0)}</div>
            </div>
          </div>

          <div className="card-white p-4">
            <div className="mb-2 text-[12px] font-semibold uppercase text-muted">Members by tier</div>
            <div className="flex flex-wrap gap-4">
              {tiers.map((t) => (
                <div key={t} className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: TIER_COLORS[t] }} />
                  <span className="text-[13px] font-semibold">{t}</span>
                  <span className="text-[13px] text-muted">{fmtNum(summary.by_tier?.[t]?.members || 0)} · {fmtNum(summary.by_tier?.[t]?.points || 0)} pts</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {report && (
        <div className="card-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[12px] font-semibold uppercase text-muted">Redemptions report</div>
            <div className="flex flex-wrap items-center gap-2">
              <input className={inputCls} type="date" value={reportFrom} onChange={(e) => setReportFrom(e.target.value)} />
              <span className="text-[12px] text-muted">to</span>
              <input className={inputCls} type="date" value={reportTo} onChange={(e) => setReportTo(e.target.value)} />
              <button className={btnGhost} onClick={loadReport}>Apply</button>
              {(reportFrom || reportTo) && (
                <button className={btnGhost} onClick={() => { setReportFrom(""); setReportTo(""); }}>Clear</button>
              )}
            </div>
          </div>
          <div className="mb-3 text-[11.5px] text-muted">
            Issued &amp; outstanding figures are scoped by issue date; codes used and discount spent are scoped by redemption date.
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md border border-border/60 p-3">
              <div className="text-[11px] uppercase text-muted">Codes issued</div>
              <div className="text-[20px] font-bold">{fmtNum(report.summary.total_codes)}</div>
              <div className="text-[11.5px] text-muted">{fmtKES(report.summary.kes_issued)} value</div>
            </div>
            <div className="rounded-md border border-border/60 p-3">
              <div className="text-[11px] uppercase text-muted">Codes used</div>
              <div className="text-[20px] font-bold">{fmtNum(report.summary.used_codes)}</div>
              <div className="text-[11.5px] text-muted">{fmtKES(report.summary.kes_used)} discount spent</div>
            </div>
            <div className="rounded-md border border-border/60 p-3">
              <div className="text-[11px] uppercase text-muted">Open (outstanding)</div>
              <div className="text-[20px] font-bold">{fmtNum(report.summary.open_codes)}</div>
              <div className="text-[11.5px] text-muted">{fmtKES(report.summary.kes_open)} liability</div>
            </div>
            <div className="rounded-md border border-border/60 p-3">
              <div className="text-[11px] uppercase text-muted">Points redeemed</div>
              <div className="text-[20px] font-bold">{fmtNum(report.summary.points_redeemed)}</div>
              <div className="text-[11.5px] text-muted">across issued codes</div>
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-1 text-[12px] font-semibold uppercase text-muted">Discount spend by store</div>
            {report.by_store.length === 0 ? (
              <div className="py-3 text-[12.5px] text-muted">No codes have been redeemed at a till yet.</div>
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border/60 text-left text-[11px] uppercase text-muted">
                    <th className="px-2 py-1">Store</th>
                    <th className="px-2 py-1 text-right">Codes used</th>
                    <th className="px-2 py-1 text-right">Discount spent</th>
                  </tr>
                </thead>
                <tbody>
                  {report.by_store.map((s) => (
                    <tr key={s.store} className="border-b border-border/40">
                      <td className="px-2 py-1.5">{s.store}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(s.used_codes)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtKES(s.kes_used)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="mt-4">
            <div className="mb-1 text-[12px] font-semibold uppercase text-muted">Recent codes</div>
            {report.recent.length === 0 ? (
              <div className="py-3 text-[12.5px] text-muted">No redemption codes issued in this range.</div>
            ) : (
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-border/60 text-left text-[11px] uppercase text-muted">
                      <th className="px-2 py-1">Code</th>
                      <th className="px-2 py-1">Member</th>
                      <th className="px-2 py-1 text-right">Discount</th>
                      <th className="px-2 py-1">Status</th>
                      <th className="px-2 py-1">Issued</th>
                      <th className="px-2 py-1">Used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.recent.map((r) => (
                      <tr key={r.discount_code} className="border-b border-border/40">
                        <td className="px-2 py-1.5 font-mono text-[12px] whitespace-nowrap">{r.discount_code}</td>
                        <td className="px-2 py-1.5">{r.member_name || "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtKES(r.kes_value)}</td>
                        <td className="px-2 py-1.5">
                          <span className={r.code_status === "used"
                            ? "rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"
                            : "rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700"}>
                            {r.code_status}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-muted">{r.issued_at ? fmtDate(r.issued_at) : "—"}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-muted">{r.used_at ? fmtDate(r.used_at) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card-white p-4">
        <div className="mb-2 text-[12px] font-semibold uppercase text-muted">Member lookup</div>
        <div className="flex gap-2">
          <input className={inputCls} placeholder="Search by name, phone or email…" value={lookup} onChange={(e) => setLookup(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
          <button className={btnPrimary} onClick={search}><MagnifyingGlass size={14} /> Search</button>
        </div>
        {results.length > 0 && (
          <ul className="mt-3 divide-y divide-border/60">
            {results.map((c) => (
              <li key={c.customer_id} className="flex cursor-pointer items-center justify-between py-2 hover:bg-panel/40" onClick={() => onOpen360(c.customer_id)}>
                <div>
                  <div className="font-semibold">{c.name || "Unnamed"}</div>
                  <div className="text-[11.5px] text-muted">{c.phone || c.email || c.customer_id}</div>
                </div>
                <div className="text-right">
                  {c.tier ? <Pill color={TIER_COLORS[c.tier] || "#6b7280"} subtle>{c.tier} · {fmtNum(c.points_balance || 0)} pts</Pill> : <span className="text-[12px] text-muted">Not enrolled</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

// =====================================================================
// Config tab (admin)
// =====================================================================

const CONFIG_LABELS = {
  "loyalty.earn_rate_kes": "KES spent to earn 1 point",
  "loyalty.points_per_kes_redeem": "Points per 1 KES on redemption",
  "loyalty.redemption_floor": "Minimum points to redeem",
  "loyalty.points_expiry_months": "Points expiry (months)",
  "loyalty.tier_silver_kes": "Silver tier — 12-mo spend (KES)",
  "loyalty.tier_gold_kes": "Gold tier — 12-mo spend (KES)",
  "loyalty.tier_vip_kes": "VIP tier — 12-mo spend (KES)",
};

const ConfigTab = () => {
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    crmGet("/crm/config")
      .then((r) => { setCfg(r.data?.config || {}); setDraft(r.data?.config || {}); })
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const save = () => {
    setSaving(true);
    api.put("/crm/config", { config: draft })
      .then((r) => { toast.success("Configuration saved"); setCfg(r.data?.config || draft); })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setSaving(false));
  };

  if (loading) return <Loading label="Loading configuration…" />;
  if (error) return <ErrorBox message={error} />;

  const keys = Object.keys(cfg || {}).sort();
  const loyaltyKeys = keys.filter((k) => k.startsWith("loyalty."));
  const slaKeys = keys.filter((k) => k.startsWith("sla."));
  const otherKeys = keys.filter((k) => !k.startsWith("loyalty.") && !k.startsWith("sla."));
  const humanize = (k) => CONFIG_LABELS[k] || k.replace(/^sla\./, "SLA · ").replace(/_/g, " ");

  const group = (title, ks) => ks.length > 0 && (
    <div className="card-white p-4">
      <div className="mb-3 text-[12px] font-semibold uppercase text-muted">{title}</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ks.map((k) => (
          <Field key={k} label={humanize(k)}>
            <input className={inputCls} value={draft[k] ?? ""} onChange={(e) => set(k, e.target.value)} />
          </Field>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <SectionTitle
        title="CRM configuration"
        subtitle="Loyalty economics and per-channel SLA targets. Admin only."
        action={<button className={btnPrimary} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>}
      />
      {group("Loyalty economics", loyaltyKeys)}
      {group("Service SLA targets (minutes)", slaKeys)}
      {group("Other", otherKeys)}
    </div>
  );
};

// =====================================================================
// Root page
// =====================================================================

// =====================================================================
// Messages tab — staff broadcast in-app messages to loyalty members
// (read in the mobile membership card). Audience: all members, one brand,
// or a single member by customer id.
// =====================================================================

const MSG_AUDIENCE_LABEL = { all: "All members", brand: "By brand", member: "One member" };
const MSG_STATUS_LABEL = { active: "Active", scheduled: "Scheduled", expired: "Expired", retracted: "Retracted" };
const MSG_STATUS_COLOR = { active: "#1a5c38", scheduled: "#d97706", expired: "#6b7280", retracted: "#6b7280" };

const fmtDateTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
};

const MessagesTab = () => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    crmGet("/crm/member-messages")
      .then((r) => setRows(r.data?.messages || []))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const retract = (id) => {
    if (!window.confirm("Retract this message? Members will stop seeing it.")) return;
    api.delete(`/crm/member-messages/${id}`)
      .then(() => { toast.success("Message retracted"); load(); })
      .catch((e) => toast.error(errOf(e)));
  };

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Member messages"
        subtitle="Send announcements and offers that loyalty members read inside the mobile membership card."
        action={<button className={btnPrimary} onClick={() => setShowCreate(true)}><Plus size={15} /> New message</button>}
      />
      {loading ? (
        <Loading label="Loading messages…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : rows.length === 0 ? (
        <Empty label="No messages sent yet." />
      ) : (
        <div className="card-white overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-semibold">Message</th>
                <th className="px-3 py-2 font-semibold">Audience</th>
                <th className="px-3 py-2 font-semibold text-right">Reach</th>
                <th className="px-3 py-2 font-semibold text-right">Read</th>
                <th className="px-3 py-2 font-semibold">Sent by</th>
                <th className="px-3 py-2 font-semibold">When</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-b border-border/60 align-top">
                  <td className="px-3 py-2">
                    <div className="font-semibold text-foreground">{m.title}</div>
                    <div className="max-w-md text-[12px] text-muted">{m.body}</div>
                  </td>
                  <td className="px-3 py-2">
                    {MSG_AUDIENCE_LABEL[m.audience] || m.audience}
                    {m.audience === "brand" && m.brand_code && <div className="mt-1"><BrandDot brand={m.brand_code} /></div>}
                  </td>
                  <td className="px-3 py-2 text-right">{fmtNum(m.reach)}</td>
                  <td className="px-3 py-2 text-right">
                    {fmtNum(m.read_count)}
                    {m.reach > 0 && <span className="ml-1 text-[11px] text-muted">({fmtPct((m.read_count / m.reach) * 100)})</span>}
                  </td>
                  <td className="px-3 py-2">{m.created_by_name || "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted">
                    {fmtDate(m.created_at)}
                    {m.publish_at && <div className="text-[11px]">Publishes {fmtDateTime(m.publish_at)}</div>}
                    {m.expires_at && <div className="text-[11px]">Hides {fmtDateTime(m.expires_at)}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <Pill color={MSG_STATUS_COLOR[m.status] || "#6b7280"} subtle>{MSG_STATUS_LABEL[m.status] || m.status}</Pill>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {m.active && (
                      <button className="text-muted hover:text-red-600" title="Retract" onClick={() => retract(m.id)}>
                        <Trash size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateMessageModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />
    </div>
  );
};

const CreateMessageModal = ({ open, onClose, onCreated }) => {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setForm({ audience: "all", brand_code: "vivo" }); }, [open]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => {
    if (!form.title?.trim() || !form.body?.trim()) { toast.error("Title and message are required"); return; }
    if (form.audience === "member" && !form.customer_id?.trim()) { toast.error("A customer id is required for a single-member message"); return; }
    const toIso = (v) => {
      if (!v) return undefined;
      const d = new Date(v);
      return isNaN(d.getTime()) ? undefined : d.toISOString();
    };
    const pub = toIso(form.publish_at);
    const exp = toIso(form.expires_at);
    if (form.expires_at && !exp) { toast.error("Invalid expiry date"); return; }
    if (pub && exp && new Date(exp) <= new Date(pub)) { toast.error("Expiry must be after the publish date"); return; }
    if (exp && new Date(exp) <= new Date()) { toast.error("Expiry must be in the future"); return; }
    const payload = {
      audience: form.audience,
      title: form.title.trim(),
      body: form.body.trim(),
      ...(form.audience === "brand" ? { brand_code: form.brand_code } : {}),
      ...(form.audience === "member" ? { customer_id: form.customer_id.trim() } : {}),
      ...(pub ? { publish_at: pub } : {}),
      ...(exp ? { expires_at: exp } : {}),
    };
    setSaving(true);
    api.post("/crm/member-messages", payload)
      .then(() => { toast.success("Message sent"); onCreated(); })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setSaving(false));
  };
  return (
    <Modal open={open} onClose={onClose} title="New member message">
      <div className="space-y-3">
        <Field label="Send to">
          <select className={inputCls} value={form.audience} onChange={(e) => set("audience", e.target.value)}>
            <option value="all">All loyalty members</option>
            <option value="brand">Members of one brand</option>
            <option value="member">A single member (by customer id)</option>
          </select>
        </Field>
        {form.audience === "brand" && (
          <Field label="Brand">
            <select className={inputCls} value={form.brand_code || "vivo"} onChange={(e) => set("brand_code", e.target.value)}>
              <option value="vivo">Vivo</option>
              <option value="sz">Shop Zetu</option>
            </select>
          </Field>
        )}
        {form.audience === "member" && (
          <Field label="Customer id">
            <input className={inputCls} placeholder="e.g. mbr:… or a customer id" value={form.customer_id || ""} onChange={(e) => set("customer_id", e.target.value)} />
          </Field>
        )}
        <Field label="Title">
          <input className={inputCls} value={form.title || ""} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="Message">
          <textarea className={inputCls} rows={4} value={form.body || ""} onChange={(e) => set("body", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Publish at (optional)">
            <input type="datetime-local" className={inputCls} value={form.publish_at || ""} onChange={(e) => set("publish_at", e.target.value)} />
          </Field>
          <Field label="Auto-hide at (optional)">
            <input type="datetime-local" className={inputCls} value={form.expires_at || ""} onChange={(e) => set("expires_at", e.target.value)} />
          </Field>
        </div>
        <p className="text-[12px] text-muted">Leave the publish date blank to send now. Set an auto-hide date to expire an offer automatically. Members see this in the mobile membership card. No emojis.</p>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={submit} disabled={saving}><PaperPlaneTilt size={15} /> {saving ? "Sending…" : "Send message"}</button>
      </div>
    </Modal>
  );
};

const TABS = [
  { key: "contacts", label: "Contacts", icon: MagnifyingGlass },
  { key: "tasks", label: "Tasks", icon: CheckCircle },
  { key: "tickets", label: "Tickets", icon: TicketIcon },
  { key: "campaigns", label: "Campaigns", icon: Megaphone },
  { key: "messages", label: "Messages", icon: ChatText },
  { key: "loyalty", label: "Loyalty", icon: Crown },
];

const CRM = () => {
  const { user } = useAuth();
  const isAdmin = (user?.role || "").toLowerCase() === "admin";
  const [tab, setTab] = useState("contacts");
  const [brand, setBrand] = useState("");
  const [team, setTeam] = useState([]);
  const [open360, setOpen360] = useState(null);

  useEffect(() => {
    crmGet("/crm/team").then((r) => setTeam(r.data?.team || [])).catch(() => {});
  }, []);

  const tabs = useMemo(() => (isAdmin ? [...TABS, { key: "config", label: "Config", icon: Gear }] : TABS), [isAdmin]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-sans text-[20px] font-bold tracking-tight text-foreground">Customer CRM</h1>
          <p className="text-[12.5px] text-muted">Relationships, service and loyalty across Vivo and Shop Zetu.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] font-semibold uppercase text-muted">Brand</span>
          <select className={`${inputCls} w-auto`} value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">All brands</option>
            <option value="vivo">Vivo</option>
            <option value="sz">Shop Zetu</option>
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-semibold ${tab === t.key ? "border-b-2 border-brand text-brand" : "text-muted hover:text-foreground"}`}
            >
              <Icon size={15} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === "contacts" && <ContactsTab brand={brand} team={team} onOpen360={setOpen360} />}
      {tab === "tasks" && <TasksTab brand={brand} team={team} />}
      {tab === "tickets" && <TicketsTab brand={brand} team={team} />}
      {tab === "campaigns" && <CampaignsTab brand={brand} />}
      {tab === "messages" && <MessagesTab />}
      {tab === "loyalty" && <LoyaltyTab isAdmin={isAdmin} onOpen360={setOpen360} />}
      {tab === "config" && isAdmin && <ConfigTab />}

      {open360 && (
        <Customer360
          customerId={open360}
          isAdmin={isAdmin}
          team={team}
          onClose={() => setOpen360(null)}
          onChanged={() => {}}
        />
      )}
    </div>
  );
};

export default CRM;
