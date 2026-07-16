import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Loading, ErrorBox } from "@/components/common";
import { Check, ArrowCounterClockwise, FloppyDisk, LockSimple, Plus, Trash, Minus, CaretDown } from "@phosphor-icons/react";
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
 *
 * Hub pages (Inventory, Retail, Production, etc.) expand to show per-report
 * checkboxes — each sub-report maps to the page ID that gates that tab.
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
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [expanded, setExpanded] = useState(new Set());

  const isAdminGroup = role === "admin";
  const isCustomGroup = Array.isArray(data?.custom) && data.custom.includes(role);

  const gLabel = useCallback(
    (r) => data?.labels?.[r] || roleLabel(r),
    [data]
  );

  const load = useCallback(() => {
    setLoading(true);
    api.get("/admin/group-pages")
      .then((r) => setData(r.data || null))
      .catch((e) => setError(e?.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!data) return;
    setSelected(Array.isArray(data.groups?.[role]) ? data.groups[role] : []);
    setSavedAt(null);
  }, [role, data]);

  // Build a map of hub page id -> deduplicated sub-report list.
  // Sub-reports correspond to actual tab pageIds within that hub page.
  const PAGE_SUB_REPORTS = useMemo(() => {
    const m = {};
    [...PRIMARY_NAV, ...ADMIN_NAV].forEach((t) => {
      if (!t.subReports?.length) return;
      const seen = new Set();
      m[t.id] = t.subReports.filter((s) => {
        if (seen.has(s.pageId)) return false;
        seen.add(s.pageId);
        return true;
      });
    });
    return m;
  }, []);

  const getSubIds = useCallback(
    (id) => {
      const subs = PAGE_SUB_REPORTS[id];
      return subs ? subs.map((s) => s.pageId) : null;
    },
    [PAGE_SUB_REPORTS]
  );

  const isOn = useCallback(
    (id) => {
      if (isAdminGroup) return true;
      const subIds = getSubIds(id);
      if (subIds) return subIds.every((sid) => selected.includes(sid));
      return selected.includes(id);
    },
    [isAdminGroup, selected, getSubIds]
  );

  const isPartial = useCallback(
    (id) => {
      if (isAdminGroup) return false;
      const subIds = getSubIds(id);
      if (!subIds) return false;
      const onCount = subIds.filter((sid) => selected.includes(sid)).length;
      return onCount > 0 && onCount < subIds.length;
    },
    [isAdminGroup, selected, getSubIds]
  );

  // Toggle a page. For hub pages, adds/removes all sub-report IDs at once.
  const toggle = useCallback(
    (id) => {
      if (isAdminGroup) return;
      const subIds = getSubIds(id);
      if (subIds) {
        const anyOn = subIds.some((sid) => selected.includes(sid));
        if (anyOn) {
          setSelected((s) => s.filter((x) => !subIds.includes(x)));
        } else {
          setSelected((s) => [...new Set([...s, ...subIds])]);
        }
      } else {
        setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
      }
    },
    [isAdminGroup, selected, getSubIds]
  );

  // Toggle an individual sub-report within a hub page.
  const toggleSubReport = useCallback(
    (pageId) => {
      if (isAdminGroup) return;
      setSelected((s) => (s.includes(pageId) ? s.filter((x) => x !== pageId) : [...s, pageId]));
    },
    [isAdminGroup]
  );

  const toggleExpand = useCallback((id) => {
    setExpanded((e) => {
      const n = new Set(e);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api.put("/admin/group-pages", { role, pages: selected });
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

  const refetch = async () => {
    const r = await api.get("/admin/group-pages");
    setData(r.data || null);
    return r.data;
  };

  const createGroup = async (e) => {
    e?.preventDefault?.();
    const label = newName.trim();
    if (!label) return;
    setCreatingGroup(true);
    setError(null);
    try {
      const r = await api.post("/admin/group-pages/groups", { label });
      await refetch();
      setRole(r.data?.role || role);
      setCreateOpen(false);
      setNewName("");
    } catch (err) {
      setError(err?.response?.data?.detail || err.message);
    } finally {
      setCreatingGroup(false);
    }
  };

  const deleteGroup = async () => {
    if (!isCustomGroup) return;
    if (!confirm(`Delete the "${gLabel(role)}" group? This cannot be undone.`)) return;
    setSaving(true);
    setError(null);
    try {
      await api.delete(`/admin/group-pages/groups/${encodeURIComponent(role)}`);
      await refetch();
      setRole("product_development");
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!confirm(`Reset ${gLabel(role)} to the ${isCustomGroup ? "empty default (no pages)" : "built-in default pages"}?`)) return;
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

  // Page catalog grouped by section — must be before any early return (Rules of Hooks).
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
          value={createOpen ? "__create__" : role}
          onChange={(e) => {
            if (e.target.value === "__create__") {
              setCreateOpen(true);
            } else {
              setCreateOpen(false);
              setRole(e.target.value);
            }
          }}
        >
          {ROLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          {(data?.custom || []).map((slug) => (
            <option key={slug} value={slug}>{gLabel(slug)}</option>
          ))}
          <option value="__create__">＋ Create new group…</option>
        </select>
        {isCustomGroup && !createOpen && (
          <button
            data-testid="delete-group-btn"
            className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg border border-danger/40 text-danger text-[12px] font-semibold hover:bg-danger/5 disabled:opacity-50"
            onClick={deleteGroup}
            disabled={saving}
            title="Delete this custom group (members must be moved to another group first)"
          >
            <Trash size={13} weight="bold" />
            Delete group
          </button>
        )}
        <span className="text-[12px] text-muted">
          {selectedCount} permission{selectedCount === 1 ? "" : "s"} granted
          {!isAdminGroup && overridden && (
            <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 text-amber-900 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide">
              Customized
            </span>
          )}
        </span>
      </div>

      {createOpen && (
        <form
          onSubmit={createGroup}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-panel px-3 py-2.5"
          data-testid="create-group-form"
        >
          <Plus size={15} weight="bold" className="text-brand shrink-0" />
          <input
            autoFocus
            className="px-3 py-2 rounded-lg border border-border text-[13px] bg-white min-w-[220px]"
            placeholder="New group name (e.g. Finance Team)"
            value={newName}
            maxLength={40}
            onChange={(e) => setNewName(e.target.value)}
            data-testid="create-group-name"
          />
          <button
            type="submit"
            className="px-3 py-2 rounded-lg bg-brand text-white font-semibold text-[13px] hover:bg-brand-deep disabled:opacity-60"
            disabled={creatingGroup || newName.trim().length < 2}
            data-testid="create-group-submit"
          >
            {creatingGroup ? "Creating…" : "Create group"}
          </button>
          <button
            type="button"
            className="px-3 py-2 rounded-lg border border-border text-[13px] font-semibold text-foreground/70 hover:bg-white"
            onClick={() => { setCreateOpen(false); setNewName(""); }}
            data-testid="create-group-cancel"
          >
            Cancel
          </button>
          <span className="text-[12px] text-muted">
            New groups start with no pages — tick the pages after creating, then Save.
          </span>
        </form>
      )}

      {error && <ErrorBox message={error} />}
      {savedAt && !error && (
        <div className="text-[12px] text-brand" data-testid="group-saved">
          Saved · {gLabel(role)} now has {selectedCount} permission{selectedCount === 1 ? "" : "s"}
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
                const subIds = getSubIds(t.id);
                const hasSubReports = !isAdminGroup && subIds && subIds.length > 0;
                const on = isOn(t.id);
                const partial = isPartial(t.id);
                const isExpandedCard = expanded.has(t.id);
                const subOnCount = hasSubReports ? subIds.filter((sid) => selected.includes(sid)).length : 0;

                if (hasSubReports) {
                  // Hub page with expandable sub-reports
                  return (
                    <div
                      key={t.id}
                      data-testid={`page-${t.id}`}
                      className={`rounded-lg border flex flex-col ${
                        on || partial
                          ? "border-brand/40 bg-brand/5"
                          : "border-border bg-muted/20"
                      }`}
                    >
                      {/* Header row: toggles all sub-reports */}
                      <button
                        type="button"
                        onClick={() => toggle(t.id)}
                        className={`flex items-center justify-between gap-3 px-3 py-2.5 text-left w-full transition ${
                          on || partial ? "text-foreground" : "text-muted"
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium truncate">{t.label}</span>
                          {t.desc && (
                            <span className="block text-[11px] text-muted truncate">{t.desc}</span>
                          )}
                        </span>
                        <span
                          className={`shrink-0 grid place-items-center w-5 h-5 rounded-md border transition ${
                            on
                              ? "bg-brand border-brand text-white"
                              : partial
                              ? "bg-brand/15 border-brand text-brand"
                              : "border-border bg-white text-transparent"
                          }`}
                        >
                          {partial ? (
                            <Minus size={11} weight="bold" />
                          ) : (
                            <Check size={13} weight="bold" />
                          )}
                        </span>
                      </button>

                      {/* Expand/collapse toggle */}
                      <button
                        type="button"
                        onClick={() => toggleExpand(t.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 border-t text-[11px] font-medium transition ${
                          on || partial
                            ? "border-brand/20 text-brand/70 hover:text-brand hover:bg-brand/5"
                            : "border-border/60 text-muted hover:text-foreground/60 hover:bg-muted/30"
                        }`}
                      >
                        <CaretDown
                          size={9}
                          weight="bold"
                          className={`transition-transform duration-150 ${isExpandedCard ? "rotate-180" : ""}`}
                        />
                        {isExpandedCard ? "Hide" : "Choose"} reports
                        <span className={`ml-auto tabular-nums ${on || partial ? "text-brand" : "text-muted"}`}>
                          {subOnCount}/{subIds.length}
                        </span>
                      </button>

                      {/* Sub-report list */}
                      {isExpandedCard && (
                        <div className="px-2 pb-2 pt-1 border-t border-border/30 space-y-0.5">
                          {PAGE_SUB_REPORTS[t.id].map((sr) => {
                            const srOn = selected.includes(sr.pageId);
                            return (
                              <button
                                key={sr.pageId}
                                type="button"
                                onClick={() => toggleSubReport(sr.pageId)}
                                data-testid={`sub-${sr.pageId}`}
                                className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md transition text-[12px] ${
                                  srOn
                                    ? "text-foreground bg-brand/8 hover:bg-brand/12"
                                    : "text-muted hover:bg-muted/40 hover:text-foreground/70"
                                }`}
                              >
                                <span
                                  className={`shrink-0 grid place-items-center w-4 h-4 rounded border transition ${
                                    srOn ? "bg-brand border-brand text-white" : "border-border bg-white text-transparent"
                                  }`}
                                >
                                  <Check size={9} weight="bold" />
                                </span>
                                <span>{sr.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                // Standard standalone page card (no sub-reports)
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
