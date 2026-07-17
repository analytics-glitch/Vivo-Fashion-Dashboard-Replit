import React, { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/api";
import { SectionTitle, Loading, ErrorBox } from "@/components/common";
import { UserPlus, Trash, ShieldCheck, Eye, X, FolderSimple, Plus, Headset } from "@phosphor-icons/react";
import SortableTable from "@/components/SortableTable";
import { useAuth } from "@/lib/auth";
import { ROLE_OPTIONS, roleLabel } from "@/lib/permissions";

const Users = () => {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "store_manager" });
  const [formErr, setFormErr] = useState(null);
  // Custom admin-created groups (from Group Access) so they're assignable here
  // too. { custom: [slug], labels: {slug: label} } — non-fatal if unavailable.
  const [groupMeta, setGroupMeta] = useState({ custom: [], labels: {} });

  const load = useCallback(() => {
    setLoading(true);
    api.get("/admin/users")
      .then((r) => setUsers(r.data || []))
      .catch((e) => setError(e?.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
    api.get("/admin/group-pages")
      .then((r) => setGroupMeta({
        custom: Array.isArray(r.data?.custom) ? r.data.custom : [],
        labels: r.data?.labels || {},
      }))
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  // Built-in departments + any custom groups created on the Group Access page.
  const allRoleOptions = [
    ...ROLE_OPTIONS,
    ...groupMeta.custom.map((slug) => ({
      value: slug,
      label: groupMeta.labels[slug] || slug,
      desc: "Custom group",
    })),
  ];
  const anyRoleLabel = (r) => groupMeta.labels[r] || roleLabel(r);

  const createUser = async (e) => {
    e.preventDefault();
    setFormErr(null);
    try {
      await api.post("/admin/users", form);
      setForm({ email: "", name: "", password: "", role: "store_manager" });
      setCreating(false);
      load();
    } catch (err) {
      setFormErr(err?.response?.data?.detail || err.message);
    }
  };

  const updateRole = async (u, role) => {
    try {
      await api.patch(`/admin/users/${u.user_id}`, { role });
      load();
    } catch (e) { alert(e?.response?.data?.detail || e.message); }
  };

  const toggleActive = async (u) => {
    try {
      await api.patch(`/admin/users/${u.user_id}`, { active: !u.active });
      load();
    } catch (e) { alert(e?.response?.data?.detail || e.message); }
  };

  const deleteUser = async (u) => {
    if (!confirm(`Delete user ${u.email}?`)) return;
    try {
      await api.delete(`/admin/users/${u.user_id}`);
      load();
    } catch (e) { alert(e?.response?.data?.detail || e.message); }
  };

  const setStatus = async (u, status) => {
    try {
      await api.patch(`/admin/users/${u.user_id}`, { status });
      load();
    } catch (e) { alert(e?.response?.data?.detail || e.message); }
  };

  const toggleCrmAdmin = async (u) => {
    try {
      await api.patch(`/admin/users/${u.user_id}`, { crm_admin: !u.crm_admin });
      load();
    } catch (e) { alert(e?.response?.data?.detail || e.message); }
  };

  // Pending users — newest first. Surfaces as a banner above the
  // standard users table so the admin can approve/reject in one click.
  const pendingUsers = users.filter((u) => (u.status || "active") === "pending");

  return (
    <div className="space-y-6" data-testid="users-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-muted text-[13px] mt-0.5">
            Manage who can access the dashboard. Google sign-in auto-creates pending Store Manager accounts for whitelisted domains — pick a department before approving.
          </p>
        </div>
        <button
          data-testid="add-user-btn"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand text-white font-semibold text-[13px] hover:bg-brand-deep"
          onClick={() => setCreating(!creating)}
        >
          <UserPlus size={14} weight="bold" />
          {creating ? "Cancel" : "Add email/password user"}
        </button>
      </div>

      {creating && (
        <form onSubmit={createUser} className="card-white p-5 grid grid-cols-1 sm:grid-cols-5 gap-3" data-testid="create-user-form">
          <input className="col-span-2 px-3 py-2 rounded-lg border border-border text-[13px]" placeholder="Email" type="email" required
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="create-user-email" />
          <input className="px-3 py-2 rounded-lg border border-border text-[13px]" placeholder="Name" required
            value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="create-user-name" />
          <input className="px-3 py-2 rounded-lg border border-border text-[13px]" placeholder="Password (min 8)" type="password" required minLength={8}
            value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} data-testid="create-user-password" />
          <select className="px-3 py-2 rounded-lg border border-border text-[13px]" value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })} data-testid="create-user-role">
            {allRoleOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
            ))}
          </select>
          {formErr && <div className="col-span-full text-danger text-[12px]">{formErr}</div>}
          <button type="submit" className="col-span-full sm:col-span-1 py-2 rounded-lg bg-brand text-white font-semibold text-[13px]" data-testid="create-user-submit">Create</button>
        </form>
      )}

      {loading && <Loading />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && pendingUsers.length > 0 && (
        <div className="card-white p-4 border-l-4 border-l-amber-400 bg-amber-50/50" data-testid="pending-approvals-card">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10.5px] font-bold uppercase tracking-wide bg-amber-100 text-amber-900 px-1.5 py-0.5 rounded">
              {pendingUsers.length} pending
            </span>
            <h3 className="font-extrabold text-[14px] text-[#7c2d12]">New sign-ups awaiting approval</h3>
          </div>
          <p className="text-[12px] text-muted mb-3">
            These users signed in via Google for the first time. Default role is <b>store manager</b> — adjust below before approving if needed.
          </p>
          <ul className="space-y-2">
            {pendingUsers.map((u) => (
              <li
                key={u.user_id}
                className="flex flex-col sm:flex-row sm:items-center gap-2 bg-white rounded-md border border-amber-200 px-3 py-2"
                data-testid={`pending-user-${u.email}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[12.5px] truncate">{u.name || u.email}</div>
                  <div className="text-[11px] text-muted truncate">{u.email}</div>
                </div>
                <select
                  className="px-2 py-1 rounded-md border border-border text-[11.5px]"
                  value={u.role}
                  onChange={(e) => updateRole(u, e.target.value)}
                  data-testid={`pending-role-${u.email}`}
                >
                  {allRoleOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => setStatus(u, "active")}
                  className="text-[11.5px] font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 px-2.5 py-1 rounded-md"
                  data-testid={`pending-approve-${u.email}`}
                >
                  Approve
                </button>
                <button
                  onClick={() => setStatus(u, "rejected")}
                  className="text-[11.5px] font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-300 px-2.5 py-1 rounded-md"
                  data-testid={`pending-reject-${u.email}`}
                >
                  Reject
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!loading && !error && (
        <div className="card-white p-5" data-testid="users-table-wrap">
          <SectionTitle title={`${users.length} users`} subtitle="Admins can manage all users; viewers are read-only" />
          <SortableTable
            testId="users-table"
            exportName="users.csv"
            initialSort={{ key: "created_at", dir: "desc" }}
            columns={[
              { key: "email", label: "Email", align: "left", render: (r) => (<span className="font-mono text-[12px]">{r.email}</span>) },
              { key: "name", label: "Name", align: "left", render: (r) => r.name || "—" },
              {
                key: "role",
                label: "Role",
                align: "left",
                render: (r) => {
                  const senior = r.role === "admin" || r.role === "leadership" || r.role === "smt";
                  const cls = senior ? "pill-green" : "pill-amber";
                  const icon = senior ? <ShieldCheck size={11} /> : <Eye size={11} />;
                  return (
                    <span className="inline-flex items-center gap-1.5 flex-wrap">
                      <span className={`${cls} inline-flex items-center gap-1`}>
                        {icon}{anyRoleLabel(r.role)}
                      </span>
                      {r.crm_admin && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-700 border border-purple-200">
                          <Headset size={9} />CRM
                        </span>
                      )}
                    </span>
                  );
                },
              },
              {
                key: "auth_method",
                label: "Method",
                align: "left",
                render: (r) => <span className="pill-neutral">{r.auth_method || "—"}</span>,
              },
              { key: "active", label: "Status", align: "left", render: (r) => (
                <span className={r.active ? "pill-green" : "pill-red"}>{r.active ? "active" : "disabled"}</span>
              ) },
              {
                key: "last_login_at",
                label: "Last Login",
                align: "left",
                render: (r) => r.last_login_at ? fmtDate(r.last_login_at) : "—",
              },
              {
                key: "actions",
                label: "",
                align: "right",
                sortable: false,
                render: (r) => (
                  <div className="flex justify-end gap-1 flex-wrap">
                    <select
                      className="text-[11px] px-1.5 py-1 rounded border border-border"
                      value={r.role}
                      onChange={(e) => updateRole(r, e.target.value)}
                      data-testid={`role-select-${r.user_id}`}
                      disabled={r.user_id === user.user_id}
                    >
                      {allRoleOptions.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <button
                      title={r.crm_admin ? "Remove CRM manager access" : "Grant CRM manager access"}
                      className={`text-[11px] px-1.5 py-1 rounded border inline-flex items-center gap-0.5 ${
                        r.crm_admin
                          ? "border-purple-400 text-purple-700 bg-purple-50"
                          : "border-border text-muted"
                      }`}
                      onClick={() => toggleCrmAdmin(r)}
                      disabled={r.user_id === user.user_id}
                      data-testid={`toggle-crm-${r.user_id}`}
                    >
                      <Headset size={11} />
                      {r.crm_admin ? "CRM" : "CRM"}
                    </button>
                    <button
                      className={`text-[11px] px-1.5 py-1 rounded border ${r.active ? "border-amber text-amber" : "border-brand text-brand"}`}
                      onClick={() => toggleActive(r)}
                      disabled={r.user_id === user.user_id}
                      data-testid={`toggle-active-${r.user_id}`}
                    >
                      {r.active ? "Disable" : "Enable"}
                    </button>
                    <button
                      className="text-[11px] px-1.5 py-1 rounded border border-danger text-danger disabled:opacity-40"
                      onClick={() => deleteUser(r)}
                      disabled={r.user_id === user.user_id}
                      data-testid={`delete-user-${r.user_id}`}
                    >
                      <Trash size={11} />
                    </button>
                  </div>
                ),
              },
            ]}
            rows={users}
          />
        </div>
      )}

      {user?.role === "admin" && <L10FoldersAdmin />}
    </div>
  );
};

// ─── L10 Departments ─────────────────────────────────────────────────────────
const FOLDER_PRESET_COLORS = [
  "#1a5c38","#7c3aed","#d97706","#0ea5e9","#e11d48","#64748b","#0d9488","#9333ea",
];

const L10FoldersAdmin = () => {
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", color: "#7c3aed" });
  const [err, setErr] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    api.get("/l10/folders", { forceFresh: true })
      .then((r) => setFolders(r.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const createFolder = async () => {
    if (!form.name.trim()) { setErr("Name is required."); return; }
    setErr(null);
    try {
      await api.post("/l10/folders", form);
      setForm({ name: "", description: "", color: "#7c3aed" });
      setCreating(false);
      reload();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to create folder.");
    }
  };

  const deleteFolder = async (id) => {
    if (!window.confirm("Delete this department folder? Meetings and data inside it will remain in the database but this folder will no longer appear.")) return;
    try {
      await api.delete(`/l10/folders/${id}`);
      reload();
    } catch (e) {
      alert(e?.response?.data?.detail || "Could not delete folder.");
    }
  };

  return (
    <div className="rounded-xl border bg-card">
      <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderSimple size={16} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold">L10 Department Folders</h2>
        </div>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-primary text-primary-foreground hover:opacity-90"
        >
          <Plus size={12} />
          {creating ? "Cancel" : "Add folder"}
        </button>
      </div>

      {creating && (
        <div className="px-4 py-3 border-b bg-muted/10 space-y-2">
          <div className="flex flex-wrap gap-2">
            <input
              placeholder="Department name *"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              className="border border-border rounded px-2.5 py-1.5 text-sm flex-1 min-w-[160px]"
            />
            <input
              placeholder="Description (optional)"
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              className="border border-border rounded px-2.5 py-1.5 text-sm flex-1 min-w-[200px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Color:</span>
            {FOLDER_PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setForm((p) => ({ ...p, color: c }))}
                className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${
                  form.color === c ? "border-foreground scale-110" : "border-transparent"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
            <input
              type="color"
              value={form.color}
              onChange={(e) => setForm((p) => ({ ...p, color: e.target.value }))}
              className="w-6 h-6 rounded border-0 cursor-pointer"
              title="Custom color"
            />
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <button
            type="button"
            onClick={createFolder}
            className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90"
          >
            Create folder
          </button>
        </div>
      )}

      {loading ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="divide-y">
          {folders.map((f) => (
            <div key={f.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: f.color || "#1a5c38" }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{f.name}</div>
                {f.description && (
                  <div className="text-xs text-muted-foreground">{f.description}</div>
                )}
              </div>
              {f.id === 1 ? (
                <span className="text-xs text-muted-foreground px-2 py-0.5 rounded bg-muted/60">Default</span>
              ) : (
                <button
                  type="button"
                  onClick={() => deleteFolder(f.id)}
                  className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-500"
                  title="Delete folder"
                >
                  <Trash size={13} />
                </button>
              )}
            </div>
          ))}
          {folders.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">No folders yet.</div>
          )}
        </div>
      )}
    </div>
  );
};

export default Users;
