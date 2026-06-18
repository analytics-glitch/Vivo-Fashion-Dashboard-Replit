import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Loading, ErrorBox } from "@/components/common";
import { Eye, EyeSlash, FloppyDisk } from "@phosphor-icons/react";
import { PRIMARY_NAV, HOME_GROUP_ORDER } from "@/lib/navItems";
import { useAuth } from "@/lib/auth";

/**
 * Admin · Page visibility — globally show/hide BI pages for EVERYONE.
 * Backed by app_config key 'hidden_pages' (GET/PUT /api/admin/page-visibility).
 * Admin management pages are never hideable (enforced server-side too).
 */
const PageVisibility = () => {
  const { checkAuth } = useAuth();
  const [hidden, setHidden] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get("/admin/page-visibility")
      .then((r) => setHidden(Array.isArray(r.data?.hidden_pages) ? r.data.hidden_pages : []))
      .catch((e) => setError(e?.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const by = {};
    PRIMARY_NAV.forEach((t) => {
      const g = t.group || "Other";
      (by[g] = by[g] || []).push(t);
    });
    const order = HOME_GROUP_ORDER.filter((g) => by[g]);
    Object.keys(by).forEach((g) => { if (!order.includes(g)) order.push(g); });
    return order.map((g) => [g, by[g]]);
  }, []);

  const isHidden = (id) => hidden.includes(id);
  const toggle = (id) =>
    setHidden((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api.put("/admin/page-visibility", { hidden_pages: hidden });
      setHidden(Array.isArray(r.data?.hidden_pages) ? r.data.hidden_pages : []);
      setSavedAt(new Date());
      // Refresh the current admin's session so the nav reflects changes now.
      await checkAuth();
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading label="Loading page visibility…" />;

  return (
    <div className="space-y-6" data-testid="page-visibility">
      <div className="flex items-start justify-between gap-4">
        <p className="text-muted text-[13px] mt-0.5 max-w-2xl">
          Hide pages from the navigation and Home grid for <strong>all users</strong>.
          Hidden pages are also blocked at the route level. Role permissions still
          apply on top of this. Administration pages can't be hidden.
        </p>
        <button
          data-testid="save-visibility-btn"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand text-white font-semibold text-[13px] hover:bg-brand-deep disabled:opacity-60"
          onClick={save}
          disabled={saving}
        >
          <FloppyDisk size={14} weight="bold" />
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>

      {error && <ErrorBox message={error} />}
      {savedAt && !error && (
        <div className="text-[12px] text-brand">
          Saved · {hidden.length} page{hidden.length === 1 ? "" : "s"} hidden
        </div>
      )}

      <div className="space-y-6">
        {grouped.map(([group, items]) => (
          <div key={group}>
            <div className="text-[11px] uppercase tracking-wide text-muted font-semibold mb-2">
              {group}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {items.map((t) => {
                const off = isHidden(t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => toggle(t.id)}
                    data-testid={`toggle-${t.id}`}
                    className={`flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border text-left transition ${
                      off
                        ? "border-border bg-muted/30 text-muted"
                        : "border-brand/30 bg-brand/5 text-ink"
                    }`}
                  >
                    <span className="text-[13px] font-medium truncate">{t.label}</span>
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] font-semibold shrink-0 ${
                        off ? "text-muted" : "text-brand"
                      }`}
                    >
                      {off ? <EyeSlash size={14} /> : <Eye size={14} />}
                      {off ? "Hidden" : "Visible"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PageVisibility;
