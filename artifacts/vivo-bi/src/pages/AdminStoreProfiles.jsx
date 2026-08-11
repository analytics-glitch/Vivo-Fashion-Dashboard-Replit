import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Loading, ErrorBox } from "@/components/common";
import { FloppyDisk, PencilSimple, X } from "@phosphor-icons/react";

/**
 * Admin Store Profiles — edit sqft and optimal_stock per store.
 * Admin-only; gated by ProtectedRoute adminOnly in App.js.
 */
const AdminStoreProfiles = () => {
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editId, setEditId] = useState(null); // location_name being edited
  const [draft, setDraft] = useState({ sqft: "", optimal_stock: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api.get("/admin/store-profiles")
      .then((r) => setStores(r.data?.stores || []))
      .catch((e) => setError(e?.response?.data?.detail || e.message || "Failed to load"))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const startEdit = (store) => {
    setEditId(store.location_name);
    setDraft({
      sqft: store.sqft != null ? String(store.sqft) : "",
      optimal_stock: store.optimal_stock != null ? String(store.optimal_stock) : "",
    });
    setSaveError(null);
  };

  const cancelEdit = () => {
    setEditId(null);
    setSaveError(null);
  };

  const saveEdit = async (locationName) => {
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {};
      if (draft.sqft !== "") payload.sqft = parseInt(draft.sqft, 10);
      if (draft.optimal_stock !== "") payload.optimal_stock = parseInt(draft.optimal_stock, 10);
      const { data } = await api.patch(
        `/admin/store-profiles/${encodeURIComponent(locationName)}`,
        payload
      );
      setStores((prev) =>
        prev.map((s) =>
          s.location_name === locationName
            ? { ...s, sqft: data.sqft, optimal_stock: data.optimal_stock }
            : s
        )
      );
      setEditId(null);
    } catch (e) {
      setSaveError(e?.response?.data?.detail || e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading label="Loading store profiles…" />;
  if (error) return <ErrorBox message={error} />;

  return (
    <div className="space-y-6" data-testid="admin-store-profiles-page">
      <div>
        <p className="text-muted text-[13px] mt-1 max-w-2xl">
          Edit square footage and optimal stock targets per store. Changes
          apply immediately and invalidate the Merch Hub drill-down cache.
        </p>
      </div>

      <div className="card-white overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-line bg-slate-50">
              <th className="text-left px-4 py-2.5 font-semibold text-muted">Store</th>
              <th className="text-left px-4 py-2.5 font-semibold text-muted">Country</th>
              <th className="text-right px-4 py-2.5 font-semibold text-muted">Sq Ft</th>
              <th className="text-right px-4 py-2.5 font-semibold text-muted">Optimal Stock</th>
              <th className="text-center px-4 py-2.5 font-semibold text-muted">Edit</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((store) => {
              const isEditing = editId === store.location_name;
              return (
                <tr
                  key={store.location_name}
                  className={`border-b border-line last:border-0 ${isEditing ? "bg-blue-50" : "hover:bg-slate-50"}`}
                >
                  <td className="px-4 py-2 font-medium text-foreground">
                    {store.location_name}
                  </td>
                  <td className="px-4 py-2 text-muted">{store.country || "—"}</td>

                  {isEditing ? (
                    <>
                      <td className="px-4 py-2 text-right">
                        <input
                          type="number"
                          min="0"
                          value={draft.sqft}
                          onChange={(e) => setDraft((d) => ({ ...d, sqft: e.target.value }))}
                          className="w-24 text-right border border-border rounded px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-brand"
                          placeholder="Sq ft"
                        />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <input
                          type="number"
                          min="0"
                          value={draft.optimal_stock}
                          onChange={(e) => setDraft((d) => ({ ...d, optimal_stock: e.target.value }))}
                          className="w-24 text-right border border-border rounded px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-brand"
                          placeholder="Units"
                        />
                      </td>
                      <td className="px-4 py-2 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => saveEdit(store.location_name)}
                            disabled={saving}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-brand text-white text-[11px] font-semibold hover:bg-brand/90 disabled:opacity-50"
                          >
                            <FloppyDisk size={13} />
                            {saving ? "Saving…" : "Save"}
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={saving}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-muted text-[11px] hover:bg-slate-100 disabled:opacity-50"
                          >
                            <X size={13} />
                          </button>
                        </div>
                        {saveError && (
                          <div className="text-rose-600 text-[10.5px] mt-1">{saveError}</div>
                        )}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">
                        {store.sqft != null ? store.sqft.toLocaleString() : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">
                        {store.optimal_stock != null ? store.optimal_stock.toLocaleString() : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <button
                          onClick={() => startEdit(store)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-border text-muted text-[11px] hover:bg-slate-100 hover:text-foreground"
                        >
                          <PencilSimple size={13} />
                          Edit
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {stores.length === 0 && (
          <div className="p-6 text-center text-muted text-[13px]">No stores found.</div>
        )}
      </div>
    </div>
  );
};

export default AdminStoreProfiles;
