import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Loading, ErrorBox } from "@/components/common";
import { Check, ArrowCounterClockwise, FloppyDisk, LockSimple } from "@phosphor-icons/react";
import { PRIMARY_NAV, ADMIN_NAV, HOME_GROUP_ORDER } from "@/lib/navItems";
import { ROLE_OPTIONS, roleLabel } from "@/lib/permissions";
import { useAuth } from "@/lib/auth";

/**
 * Admin · Group Access — choose which BI pages each department GROUP can see.
 *
 * Backed by app_config key 'role_pages' (GET/PUT /api/admin/group-pages). The
 * effective list a group resolves to is surfaced as `allowed_pages` on
 * /auth/me, so members of the group immediately see exactly those pages in the
 * nav, the Home tiles and the route guard once their session refreshes.
 *
 * Guard rails: the Admin group always resolves to full access (cannot be locked
 * out — checkboxes shown ticked + disabled), and admin management pages are
 * never assignable to non-admin groups (enforced server-side too).
 */
const GroupAccess = () => {
  const { checkAuth } = useAuth();
  const [role, setRole] = useState("product_development");
  const [data, setData] = useState(null); // { groups, defaults, overridden, page_catalog }
  const [selected, setSelected] = useState([]); // page ids ticked for the active group
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  const isAdminGroup = role === "admin";

  const load = useCallback(() => {
    setLoading(true);
    api.get("/admin/group-pages")
      .then((r) => setData(r.data || null))
      .catch((e) => setError(e?.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // When the selected group (or freshly-loaded data) changes, seed the ticked
  // set from that group's currently-effective pages.
  useEffect(() => {
    if (!data) return;
    setSelected(Array.isArray(data.groups?.[role]) ? data.groups[role] : []);
    setSavedAt(null);
  }, [role, data]);

  // Page catalog grouped by section. Admin group sees the Administration group
  // too; non-admin groups never get admin- pages assigned.
  const grouped = useMemo(() => {
    const items = isAdminGroup ? [...PRIMARY_NAV, ...ADMIN_NAV] : PRIMARY_NAV;
    const by = {};
    items.forEach((t) => {
      const g = t.group || "Other";
      (by[g] = by[g] || []).push(t);
    });
    const order = HOME_GROUP_ORDER.filter((g) => by[g]);
    Object.keys(by).forEach((g) => { if (!order.includes(g)) order.push(g); });
    return order.map((g) => [g, by[g]]);
  }, [isAdminGroup]);

  const isOn = (id) => isAdminGroup || selected.includes(id);
  const toggle = (id) => {
    if (isAdminGroup) return; // admin always full — not editable
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api.put("/admin/group-pages", { role, pages: selected });
      // Reflect the cleaned, server-canonical list back into our cache + state.
      const pages = Array.isArray(r.data?.pages) ? r.data.pages : selected;
      setData((d) => (d ? { ...d, groups: { ...d.groups, [role]: pages }, overridden: { ...d.overridden, [role]: true } } : d));
      setSelected(pages);
      setSavedAt(new Date());
      await checkAuth();
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!confirm(`Reset ${roleLabel(role)} to the built-in default pages?`)) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.put("/admin/group-pages", { role, reset: true });
      const pages = Array.isArray(r.data?.pages) ? r.data.pages : (data?.defaults?.[role] || []);
      setData((d) => (d ? { ...d, groups: { ...d.groups, [role]: pages }, overridden: { ...d.overridden, [role]: false } } : d));
      setSelected(pages);
      setSavedAt(new Date());
      await checkAuth();
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading label="Loading group access…" />;

  const overridden = Boolean(data?.overridden?.[role]);
  const selectedCount = isAdminGroup ? (data?.page_catalog?.length || 0) : selected.length;

  return (
    <div className="space-y-6" data-testid="group-access">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <p className="text-muted text-[13px] mt-0.5 max-w-2xl">
          Choose which pages each <strong>group</strong> can see. Members of the
          group see exactly the ticked pages in the navigation, the Home tiles
          and via direct URL once their session refreshes. The <strong>Admin</strong> group
          always has full access. Sensitive data still stays protected by the
          backend role checks, so granting a page whose data is role-gated may
          show as empty.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            data-testid="reset-group-btn"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-foreground/80 font-semibold text-[13px] hover:bg-panel disabled:opacity-50"
            onClick={reset}
            disabled={saving || isAdminGroup}
            title={isAdminGroup ? "The Admin group always has full access" : "Restore the built-in default for this group"}
          >
            <ArrowCounterClockwise size={14} weight="bold" />
            Reset to default
          </button>
          <button
            data-testid="save-group-btn"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand text-white font-semibold text-[13px] hover:bg-brand-deep disabled:opacity-60"
            onClick={save}
            disabled={saving || isAdminGroup}
            title={isAdminGroup ? "The Admin group always has full access" : "Save this group's page access"}
          >
            <FloppyDisk size={14} weight="bold" />
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[12px] font-semibold text-muted uppercase tracking-wide" htmlFor="group-select">
          Group
        </label>
        <select
          id="group-select"
          data-testid="group-select"
          className="px-3 py-2 rounded-lg border border-border text-[13px] bg-white"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          {ROLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span className="text-[12px] text-muted">
          {selectedCount} page{selectedCount === 1 ? "" : "s"} visible
          {!isAdminGroup && overridden && (
            <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 text-amber-900 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide">
              Customized
            </span>
          )}
        </span>
      </div>

      {error && <ErrorBox message={error} />}
      {savedAt && !error && (
        <div className="text-[12px] text-brand" data-testid="group-saved">
          Saved · {roleLabel(role)} now sees {selectedCount} page{selectedCount === 1 ? "" : "s"}
        </div>
      )}

      {isAdminGroup && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-panel px-3 py-2.5 text-[12.5px] text-muted" data-testid="admin-locked-note">
          <LockSimple size={15} weight="bold" />
          The Admin group always has access to every page — including the admin
          management tools — and cannot be restricted.
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
                const on = isOn(t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => toggle(t.id)}
                    disabled={isAdminGroup}
                    data-testid={`page-${t.id}`}
                    className={`flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border text-left transition disabled:cursor-not-allowed ${
                      on
                        ? "border-brand/40 bg-brand/5 text-foreground"
                        : "border-border bg-muted/20 text-muted"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium truncate">{t.label}</span>
                      {t.desc && (
                        <span className="block text-[11px] text-muted truncate">{t.desc}</span>
                      )}
                    </span>
                    <span
                      className={`shrink-0 grid place-items-center w-5 h-5 rounded-md border ${
                        on ? "bg-brand border-brand text-white" : "border-border bg-white text-transparent"
                      }`}
                    >
                      <Check size={13} weight="bold" />
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

export default GroupAccess;
