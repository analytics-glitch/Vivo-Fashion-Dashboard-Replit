import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Loading, ErrorBox, Empty } from "@/components/common";
import {
  FolderSimple,
  FolderOpen,
  FilePdf,
  FileDoc,
  FileXls,
  FilePpt,
  FileImage,
  File as FileIcon,
  UploadSimple,
  DownloadSimple,
  Eye,
  Trash,
  ArrowLeft,
  ShieldCheck,
  X,
} from "@phosphor-icons/react";

/**
 * SOPs — the company's Standard Operating Procedure library.
 *
 * Every signed-in active user can browse the seven department folders and
 * view/download documents. Uploading + deleting inside a folder is allowed
 * only for admins and for users an admin has explicitly granted that
 * department (server-enforced via /api/sops/*; the `can_upload` flags here
 * only drive which buttons render). Admins also get a "Manage upload access"
 * panel on this page backed by /api/admin/sop-grants.
 */

const fmtSize = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};

const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
};

const extOf = (name) => {
  const i = (name || "").lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
};

const FileTypeIcon = ({ filename, size = 22 }) => {
  const ext = extOf(filename);
  if (ext === "pdf") return <FilePdf size={size} weight="duotone" className="text-red-500" />;
  if (ext === "doc" || ext === "docx") return <FileDoc size={size} weight="duotone" className="text-blue-500" />;
  if (ext === "xls" || ext === "xlsx") return <FileXls size={size} weight="duotone" className="text-emerald-600" />;
  if (ext === "ppt" || ext === "pptx") return <FilePpt size={size} weight="duotone" className="text-orange-500" />;
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return <FileImage size={size} weight="duotone" className="text-violet-500" />;
  return <FileIcon size={size} weight="duotone" className="text-slate-400" />;
};

const VIEWABLE_EXTS = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp"]);
const ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp";
const MAX_MB = 20;

// Fetch a file as an authed blob (Bearer header via the axios interceptor)
// and hand back an object URL. Used for both View and Download so the links
// work regardless of cookie state.
const fetchBlobUrl = async (fileId, inline) => {
  const r = await api.get(`/sops/files/${fileId}/download${inline ? "?inline=1" : ""}`, {
    responseType: "blob",
    forceFresh: true,
  });
  return URL.createObjectURL(r.data);
};

const SOPs = () => {
  const { user } = useAuth();
  const isAdmin = (user?.role || "").toLowerCase() === "admin";

  const [departments, setDepartments] = useState(null);
  const [deptError, setDeptError] = useState(null);
  const [selected, setSelected] = useState(null); // slug of the open folder

  const loadDepartments = useCallback(() => {
    api.get("/sops/departments", { forceFresh: true })
      .then((r) => { setDepartments(r.data || []); setDeptError(null); })
      .catch((e) => setDeptError(e?.response?.data?.detail || e.message));
  }, []);

  useEffect(() => { loadDepartments(); }, [loadDepartments]);

  const selectedDept = useMemo(
    () => (departments || []).find((d) => d.slug === selected) || null,
    [departments, selected],
  );

  return (
    <div className="space-y-6" data-testid="sops-page">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Standard Operating Procedures</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Department SOP documents — open a folder to view or download files.
          Uploading is limited to team members with upload access for that department.
        </p>
      </div>

      {deptError && <ErrorBox message={deptError} />}
      {!departments && !deptError && <Loading label="Loading SOP folders…" />}

      {departments && !selected && (
        <FolderGrid departments={departments} onOpen={setSelected} />
      )}

      {departments && selected && (
        <FolderView
          dept={selectedDept || { slug: selected, name: selected, can_upload: false }}
          onBack={() => { setSelected(null); loadDepartments(); }}
          onChanged={loadDepartments}
        />
      )}

      {isAdmin && <AdminGrantsPanel departments={departments || []} onChanged={loadDepartments} />}
    </div>
  );
};

const FolderGrid = ({ departments, onOpen }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
    {departments.map((d) => (
      <button
        key={d.slug}
        type="button"
        onClick={() => onOpen(d.slug)}
        data-testid={`sop-folder-${d.slug}`}
        className="group text-left rounded-xl border bg-card p-5 hover:border-primary/50 hover:shadow-sm transition-all"
      >
        <div className="flex items-start justify-between">
          <FolderSimple size={34} weight="duotone" className="text-amber-500 group-hover:hidden" />
          <FolderOpen size={34} weight="duotone" className="text-amber-500 hidden group-hover:block" />
          {d.can_upload && (
            <span className="text-[10px] uppercase tracking-wide font-medium rounded-full px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200">
              Upload access
            </span>
          )}
        </div>
        <div className="mt-3 font-medium leading-snug">{d.name}</div>
        <div className="text-xs text-muted-foreground mt-1">
          {d.file_count === 1 ? "1 document" : `${d.file_count} documents`}
        </div>
      </button>
    ))}
  </div>
);

const FolderView = ({ dept, onBack, onChanged }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState(null);
  const fileInput = useRef(null);

  const load = useCallback(() => {
    api.get(`/sops/files?department=${encodeURIComponent(dept.slug)}`, { forceFresh: true })
      .then((r) => { setData(r.data); setError(null); })
      .catch((e) => setError(e?.response?.data?.detail || e.message));
  }, [dept.slug]);

  useEffect(() => { setData(null); load(); }, [load]);

  const flash = (msg, isError) => {
    setNotice({ msg, isError });
    setTimeout(() => setNotice(null), 4000);
  };

  const onUpload = async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    if (file.size > MAX_MB * 1024 * 1024) {
      flash(`"${file.name}" is larger than the ${MAX_MB} MB limit.`, true);
      return;
    }
    const existing = (data?.files || []).some(
      (f) => f.filename.toLowerCase() === file.name.toLowerCase());
    if (existing && !window.confirm(
      `"${file.name}" already exists in this folder. Replace it with this new version?`)) {
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("department", dept.slug);
      fd.append("file", file);
      await api.post("/sops/upload", fd, { headers: { "Content-Type": "multipart/form-data" } });
      flash(existing ? `Replaced "${file.name}".` : `Uploaded "${file.name}".`);
      load();
      onChanged?.();
    } catch (e) {
      flash(e?.response?.data?.detail || e.message || "Upload failed", true);
    } finally {
      setUploading(false);
    }
  };

  const onView = async (f) => {
    setBusyId(f.id);
    try {
      const url = await fetchBlobUrl(f.id, true);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      flash(e?.response?.data?.detail || "Could not open the file", true);
    } finally {
      setBusyId(null);
    }
  };

  const onDownload = async (f) => {
    setBusyId(f.id);
    try {
      const url = await fetchBlobUrl(f.id, false);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      flash(e?.response?.data?.detail || "Download failed", true);
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (f) => {
    if (!window.confirm(`Delete "${f.filename}"? This cannot be undone.`)) return;
    setBusyId(f.id);
    try {
      await api.delete(`/sops/files/${f.id}`);
      flash(`Deleted "${f.filename}".`);
      load();
      onChanged?.();
    } catch (e) {
      flash(e?.response?.data?.detail || "Delete failed", true);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-3 p-4 border-b">
        <button
          type="button"
          onClick={onBack}
          data-testid="sop-back"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} /> All folders
        </button>
        <div className="flex items-center gap-2 font-medium">
          <FolderOpen size={20} weight="duotone" className="text-amber-500" />
          {dept.name}
        </div>
        <div className="ml-auto">
          {data?.can_upload && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={onUpload}
              />
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
                data-testid="sop-upload-btn"
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground text-sm px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
              >
                <UploadSimple size={16} />
                {uploading ? "Uploading…" : "Upload document"}
              </button>
            </>
          )}
        </div>
      </div>

      {notice && (
        <div className={`mx-4 mt-3 rounded-lg border px-3 py-2 text-sm ${notice.isError
          ? "border-red-200 bg-red-50 text-red-700"
          : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
          {notice.msg}
        </div>
      )}

      <div className="p-4">
        {error && <ErrorBox message={error} />}
        {!data && !error && <Loading label="Loading documents…" />}
        {data && data.files.length === 0 && (
          <Empty label="No documents in this folder yet." />
        )}
        {data && data.files.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">Document</th>
                  <th className="py-2 pr-3 font-medium">Size</th>
                  <th className="py-2 pr-3 font-medium">Uploaded</th>
                  <th className="py-2 pr-3 font-medium">By</th>
                  <th className="py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.files.map((f) => (
                  <tr key={f.id} className="border-b last:border-0 hover:bg-muted/40" data-testid={`sop-file-${f.id}`}>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileTypeIcon filename={f.filename} />
                        <span className="truncate max-w-[360px]" title={f.filename}>{f.filename}</span>
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">{fmtSize(f.size_bytes)}</td>
                    <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">{fmtDate(f.uploaded_at)}</td>
                    <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground truncate max-w-[180px]" title={f.uploaded_by_email || ""}>
                      {f.uploaded_by || f.uploaded_by_email || "—"}
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {VIEWABLE_EXTS.has(extOf(f.filename)) && (
                          <button
                            type="button"
                            title="View"
                            disabled={busyId === f.id}
                            onClick={() => onView(f)}
                            className="rounded-md p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
                            data-testid={`sop-view-${f.id}`}
                          >
                            <Eye size={17} />
                          </button>
                        )}
                        <button
                          type="button"
                          title="Download"
                          disabled={busyId === f.id}
                          onClick={() => onDownload(f)}
                          className="rounded-md p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
                          data-testid={`sop-download-${f.id}`}
                        >
                          <DownloadSimple size={17} />
                        </button>
                        {data.can_upload && (
                          <button
                            type="button"
                            title="Delete"
                            disabled={busyId === f.id}
                            onClick={() => onDelete(f)}
                            className="rounded-md p-1.5 hover:bg-red-50 text-muted-foreground hover:text-red-600 disabled:opacity-50"
                            data-testid={`sop-delete-${f.id}`}
                          >
                            <Trash size={17} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

const AdminGrantsPanel = ({ departments, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [grants, setGrants] = useState(null);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [selUser, setSelUser] = useState("");
  const [selDept, setSelDept] = useState("");

  const deptName = useMemo(() => {
    const m = {};
    departments.forEach((d) => { m[d.slug] = d.name; });
    return m;
  }, [departments]);

  const load = useCallback(() => {
    Promise.all([
      api.get("/admin/sop-grants", { forceFresh: true }),
      api.get("/admin/users", { forceFresh: true }),
    ])
      .then(([g, u]) => {
        setGrants(g.data || []);
        const list = Array.isArray(u.data) ? u.data : (u.data?.users || []);
        setUsers(list.filter((x) => (x.status || "") === "active"));
        setError(null);
      })
      .catch((e) => setError(e?.response?.data?.detail || e.message));
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const addGrant = async () => {
    if (!selUser || !selDept) return;
    setSaving(true);
    try {
      await api.post("/admin/sop-grants", { user_id: selUser, department: selDept });
      setSelDept("");
      load();
      onChanged?.();
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    } finally {
      setSaving(false);
    }
  };

  const removeGrant = async (g) => {
    setSaving(true);
    try {
      await api.delete(`/admin/sop-grants?user_id=${encodeURIComponent(g.user_id)}&department=${encodeURIComponent(g.department)}`);
      load();
      onChanged?.();
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="sop-grants-toggle"
        className="w-full flex items-center gap-2 p-4 text-left"
      >
        <ShieldCheck size={20} weight="duotone" className="text-primary" />
        <div>
          <div className="font-medium">Manage upload access</div>
          <div className="text-xs text-muted-foreground">
            Grant specific users the right to upload &amp; delete SOP documents in a department (admins can always upload everywhere).
          </div>
        </div>
        <span className="ml-auto text-xs text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="border-t p-4 space-y-4">
          {error && <ErrorBox message={error} />}
          {(!grants || !users) && !error && <Loading label="Loading access grants…" />}
          {grants && users && (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-sm">
                  <div className="text-xs text-muted-foreground mb-1">User</div>
                  <select
                    value={selUser}
                    onChange={(e) => setSelUser(e.target.value)}
                    data-testid="sop-grant-user"
                    className="rounded-lg border bg-background px-2.5 py-1.5 text-sm min-w-[220px]"
                  >
                    <option value="">Select a user…</option>
                    {users.map((u) => (
                      <option key={u.user_id} value={u.user_id}>
                        {u.name ? `${u.name} — ${u.email}` : u.email}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <div className="text-xs text-muted-foreground mb-1">Department folder</div>
                  <select
                    value={selDept}
                    onChange={(e) => setSelDept(e.target.value)}
                    data-testid="sop-grant-dept"
                    className="rounded-lg border bg-background px-2.5 py-1.5 text-sm min-w-[220px]"
                  >
                    <option value="">Select a department…</option>
                    {departments.map((d) => (
                      <option key={d.slug} value={d.slug}>{d.name}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={addGrant}
                  disabled={saving || !selUser || !selDept}
                  data-testid="sop-grant-add"
                  className="rounded-lg bg-primary text-primary-foreground text-sm px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
                >
                  Grant access
                </button>
              </div>

              {grants.length === 0 ? (
                <Empty label="No upload grants yet — only admins can upload." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b">
                        <th className="py-2 pr-3 font-medium">User</th>
                        <th className="py-2 pr-3 font-medium">Department</th>
                        <th className="py-2 pr-3 font-medium">Granted by</th>
                        <th className="py-2 pr-3 font-medium">Granted</th>
                        <th className="py-2 font-medium text-right">Revoke</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grants.map((g) => (
                        <tr key={`${g.user_id}|${g.department}`} className="border-b last:border-0">
                          <td className="py-2 pr-3">
                            <div className="truncate max-w-[260px]">{g.name || g.email || g.user_id}</div>
                            {g.email && g.name && (
                              <div className="text-xs text-muted-foreground truncate max-w-[260px]">{g.email}</div>
                            )}
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap">{deptName[g.department] || g.department}</td>
                          <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{g.granted_by || "—"}</td>
                          <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{fmtDate(g.granted_at)}</td>
                          <td className="py-2">
                            <div className="flex justify-end">
                              <button
                                type="button"
                                title="Revoke"
                                disabled={saving}
                                onClick={() => removeGrant(g)}
                                data-testid={`sop-grant-revoke-${g.user_id}-${g.department}`}
                                className="rounded-md p-1.5 hover:bg-red-50 text-muted-foreground hover:text-red-600 disabled:opacity-50"
                              >
                                <X size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default SOPs;
