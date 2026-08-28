import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  CheckCircle,
  ArrowRight,
  Archive,
  PencilSimple,
  FloppyDisk,
  X,
} from "@phosphor-icons/react";

/**
 * SOPs — the company's Standard Operating Procedure library.
 *
 * Every signed-in active user can access Submission and the Approved master
 * repository. Admins plus the named reviewers also see Under Review, Awaiting
 * Approval and Obsolete. Upload grants, stage visibility, editing and approval are all
 * enforced by /api/sops/*; the flags here only drive which controls render.
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
const ACCEPT = ".docx";
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

const LegacySOPs = () => {
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
      {isAdmin && <FabricFieldGrantsPanel />}
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
    if (extOf(file.name) !== "docx") {
      flash("Only modern Word documents (.docx) can be uploaded.", true);
      return;
    }
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

const WorkflowStageGrid = ({ stages, onOpen }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
    {stages.map((stage) => (
      <button
        key={stage.id}
        type="button"
        onClick={() => onOpen(stage)}
        data-testid={`sop-stage-${stage.slug}`}
        className="group text-left rounded-xl border bg-card p-5 hover:border-primary/50 hover:shadow-sm transition-all"
      >
        <div className="flex items-start justify-between gap-3">
          <FolderSimple size={36} weight="duotone" className="text-amber-500 group-hover:hidden" />
          <FolderOpen size={36} weight="duotone" className="text-amber-500 hidden group-hover:block" />
          <span className="text-[10px] uppercase tracking-wide font-medium rounded-full px-2 py-0.5 bg-slate-50 text-slate-600 border">
            {stage.department_count} departments
          </span>
        </div>
        <div className="mt-3 font-semibold leading-snug min-h-[2.5rem]">{stage.name}</div>
        <div className="text-xs text-muted-foreground mt-1">
          {stage.file_count === 1 ? "1 document" : `${stage.file_count} documents`}
        </div>
      </button>
    ))}
  </div>
);

const WorkflowDepartmentGrid = ({ stage, departments, onOpen, onBack }) => (
  <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={onBack}
        data-testid="sop-stage-back"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={16} /> All workflow folders
      </button>
      <div className="flex items-center gap-2 font-semibold">
        <FolderOpen size={20} weight="duotone" className="text-amber-500" />
        {stage.name}
      </div>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {departments.map((department) => (
        <button
          key={department.slug}
          type="button"
          onClick={() => onOpen(department)}
          data-testid={`sop-department-${department.slug}`}
          className="group text-left rounded-xl border bg-card p-5 hover:border-primary/50 hover:shadow-sm transition-all"
        >
          <div className="flex items-start justify-between gap-3">
            <FolderSimple size={34} weight="duotone" className="text-amber-500 group-hover:hidden" />
            <FolderOpen size={34} weight="duotone" className="text-amber-500 hidden group-hover:block" />
            {department.can_upload && (
              <span className="text-[10px] uppercase tracking-wide font-medium rounded-full px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200">
                Submit
              </span>
            )}
          </div>
          <div className="mt-3 font-medium leading-snug">{department.name}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {department.file_count === 1 ? "1 document" : `${department.file_count} documents`}
          </div>
        </button>
      ))}
    </div>
  </div>
);

const SopEditorModal = ({ file, onClose, onSaved }) => {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editorRef = useRef(null);

  useEffect(() => {
    let active = true;
    api.get(`/sops/files/${file.id}/editor`, { forceFresh: true })
      .then((r) => {
        if (!active) return;
        setDoc(r.data);
        setError(null);
      })
      .catch((e) => {
        if (active) setError(e?.response?.data?.detail || e.message);
      });
    return () => { active = false; };
  }, [file.id]);

  useEffect(() => {
    if (doc && editorRef.current) editorRef.current.innerHTML = doc.html || "";
  }, [doc?.id]);

  const close = () => {
    if (dirty && !window.confirm("Discard your unsaved SOP changes?")) return;
    onClose();
  };

  const format = (command, value) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    setDirty(true);
  };

  const save = async (transition) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.put(`/sops/files/${file.id}/editor`, {
        html: editorRef.current?.innerHTML || "",
        revision: doc.revision,
        transition,
      });
      if (transition === "save") {
        setDoc((current) => ({
          ...current,
          revision: r.data.file.editor_revision,
          edited_at: r.data.file.edited_at,
        }));
        setDirty(false);
        setNotice("Changes saved.");
        onSaved?.(false);
      } else {
        onSaved?.(true);
        onClose();
      }
    } catch (e) {
      setError(e?.response?.data?.detail || e.message || "Could not save the SOP");
    } finally {
      setSaving(false);
    }
  };

  const modal = (
    <div className="fixed inset-0 z-[100] bg-slate-950/55 p-3 sm:p-6 flex items-center justify-center" data-testid="sop-editor-modal">
      <div className="w-full max-w-5xl max-h-[94vh] rounded-2xl bg-background border shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-start gap-3 border-b px-4 sm:px-6 py-4">
          <div className="rounded-lg bg-blue-50 p-2 text-blue-700">
            <PencilSimple size={22} weight="duotone" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold truncate">{file.filename}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {doc?.stage === 2
                ? "Review, edit and send this SOP to Awaiting Approval."
                : "Make final edits before approving this SOP."}
            </p>
          </div>
          <button type="button" onClick={close} className="ml-auto rounded-lg p-2 hover:bg-muted" aria-label="Close SOP editor">
            <X size={20} />
          </button>
        </div>

        <div className="border-b px-4 sm:px-6 py-2 flex flex-wrap gap-1 bg-muted/30" aria-label="Formatting controls">
          <button type="button" onClick={() => format("bold")} className="rounded px-2.5 py-1 text-sm font-bold hover:bg-background border">B</button>
          <button type="button" onClick={() => format("italic")} className="rounded px-2.5 py-1 text-sm italic hover:bg-background border">I</button>
          <button type="button" onClick={() => format("underline")} className="rounded px-2.5 py-1 text-sm underline hover:bg-background border">U</button>
          <button type="button" onClick={() => format("formatBlock", "h2")} className="rounded px-2.5 py-1 text-sm hover:bg-background border">Heading</button>
          <button type="button" onClick={() => format("formatBlock", "p")} className="rounded px-2.5 py-1 text-sm hover:bg-background border">Paragraph</button>
          <button type="button" onClick={() => format("insertUnorderedList")} className="rounded px-2.5 py-1 text-sm hover:bg-background border">Bullets</button>
          <button type="button" onClick={() => format("insertOrderedList")} className="rounded px-2.5 py-1 text-sm hover:bg-background border">Numbered</button>
        </div>

        <div className="flex-1 overflow-auto p-4 sm:p-6 bg-slate-50/70">
          {!doc && !error && <Loading label="Opening SOP editor…" />}
          {error && <ErrorBox message={error} />}
          {notice && <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 px-3 py-2 text-sm">{notice}</div>}
          {doc && (
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              aria-label="SOP document content"
              onInput={() => setDirty(true)}
              data-testid="sop-editor-content"
              className="mx-auto min-h-[54vh] max-w-3xl bg-white border rounded-md shadow-sm px-8 sm:px-12 py-10 text-[15px] leading-7 outline-none focus:ring-2 focus:ring-primary/20 [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:mb-5 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:mb-4 [&_h3]:text-xl [&_h3]:font-semibold [&_p]:mb-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:w-full [&_table]:border-collapse [&_table]:mb-4 [&_th]:border [&_th]:border-slate-300 [&_th]:bg-slate-100 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_td]:border [&_td]:border-slate-300 [&_td]:px-3 [&_td]:py-2"
            />
          )}
        </div>

        <div className="border-t px-4 sm:px-6 py-4 flex flex-wrap items-center gap-2 bg-background">
          <div className="text-xs text-muted-foreground mr-auto">
            {doc?.edited_at ? `Last saved ${fmtDate(doc.edited_at)}` : "Original upload retained for traceability"}
          </div>
          <button type="button" onClick={close} disabled={saving} className="rounded-lg border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save("save")}
            disabled={!doc || saving}
            data-testid="sop-editor-save"
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <FloppyDisk size={16} /> Save changes
          </button>
          {doc?.stage === 2 && (
            <button
              type="button"
              onClick={() => save("awaiting_approval")}
              disabled={saving}
              data-testid="sop-editor-send-approval"
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 text-white px-3 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              <ArrowRight size={16} /> Save &amp; send to Awaiting Approval
            </button>
          )}
          {doc?.stage === 5 && (
            <button
              type="button"
              onClick={() => save("approve")}
              disabled={saving}
              data-testid="sop-editor-approve"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 text-white px-3 py-2 text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              <CheckCircle size={16} /> Save &amp; approve
            </button>
          )}
        </div>
      </div>
    </div>
  );
  return createPortal(modal, document.body);
};

const WorkflowFolderView = ({ stage, dept, onBack, onChanged }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [editingFile, setEditingFile] = useState(null);
  const fileInput = useRef(null);

  const load = useCallback(() => {
    api.get(`/sops/files?stage=${stage.id}&department=${encodeURIComponent(dept.slug)}`, { forceFresh: true })
      .then((r) => { setData(r.data); setError(null); })
      .catch((e) => setError(e?.response?.data?.detail || e.message));
  }, [stage.id, dept.slug]);

  useEffect(() => { setData(null); load(); }, [load]);

  const flash = (msg, isError = false) => {
    setNotice({ msg, isError });
    setTimeout(() => setNotice(null), 4000);
  };

  const refresh = () => {
    load();
    onChanged?.();
  };

  const onUpload = async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    if (extOf(file.name) !== "docx") {
      flash("Only modern Word documents (.docx) can be uploaded.", true);
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      flash(`"${file.name}" is larger than the ${MAX_MB} MB limit.`, true);
      return;
    }
    const existing = (data?.files || []).some(
      (item) => item.filename.toLowerCase() === file.name.toLowerCase());
    if (existing && !window.confirm(
      `"${file.name}" already exists in this submission folder. Replace it?`)) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("department", dept.slug);
      fd.append("file", file);
      await api.post("/sops/upload", fd, { headers: { "Content-Type": "multipart/form-data" } });
      flash(existing ? `Replaced "${file.name}".` : `Submitted "${file.name}".`);
      refresh();
    } catch (e) {
      flash(e?.response?.data?.detail || e.message || "Submission failed", true);
    } finally {
      setUploading(false);
    }
  };

  const onView = async (file) => {
    setBusyId(file.id);
    try {
      const url = await fetchBlobUrl(file.id, true);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      flash(e?.response?.data?.detail || "Could not open the file", true);
    } finally {
      setBusyId(null);
    }
  };

  const onDownload = async (file) => {
    setBusyId(file.id);
    try {
      const url = await fetchBlobUrl(file.id, false);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
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

  const onDownloadOriginal = async (file) => {
    setBusyId(file.id);
    try {
      const r = await api.get(`/sops/files/${file.id}/original`, {
        responseType: "blob",
        forceFresh: true,
      });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.original_filename || file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      flash(e?.response?.data?.detail || "Original download failed", true);
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (file) => {
    if (!window.confirm(`Delete "${file.filename}"? This cannot be undone.`)) return;
    setBusyId(file.id);
    try {
      await api.delete(`/sops/files/${file.id}`);
      flash(`Deleted "${file.filename}".`);
      refresh();
    } catch (e) {
      flash(e?.response?.data?.detail || "Delete failed", true);
    } finally {
      setBusyId(null);
    }
  };

  const transition = async (file, action) => {
    setBusyId(file.id);
    try {
      await api.post(`/sops/files/${file.id}/${action}`);
      flash(action === "review"
        ? `Moved "${file.filename}" to SOPs Under Review.`
        : action === "approve"
          ? `Approved "${file.filename}" and moved it to the Master Repository.`
          : `Marked "${file.filename}" as Obsolete and moved it to Obsolete SOPs.`);
      refresh();
    } catch (e) {
      flash(e?.response?.data?.detail || `${action === "review" ? "Review" : "Approval"} failed`, true);
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
          data-testid="sop-department-back"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} /> {stage.name}
        </button>
        <div className="flex items-center gap-2 font-medium">
          <FolderOpen size={20} weight="duotone" className="text-amber-500" />
          {dept.name}
        </div>
        <div className="ml-auto">
          {data?.can_upload && (
            <>
              <input ref={fileInput} type="file" accept={ACCEPT} className="hidden" onChange={onUpload} />
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
                data-testid="sop-upload-btn"
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground text-sm px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
              >
                <UploadSimple size={16} />
                {uploading ? "Submitting…" : "Submit Word SOP"}
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
        {data && data.files.length === 0 && <Empty label="No documents in this folder yet." />}
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
                {data.files.map((file) => (
                  <tr key={file.id} className="border-b last:border-0 hover:bg-muted/40" data-testid={`sop-file-${file.id}`}>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileTypeIcon filename={file.filename} />
                        {data.can_edit ? (
                          <button
                            type="button"
                            onClick={() => setEditingFile(file)}
                            className="truncate max-w-[360px] text-left font-medium text-blue-700 hover:underline"
                            title={`Edit ${file.filename}`}
                            data-testid={`sop-edit-name-${file.id}`}
                          >
                            {file.filename}
                          </button>
                        ) : (
                          <span className="truncate max-w-[360px]" title={file.filename}>{file.filename}</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">{fmtSize(file.size_bytes)}</td>
                    <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">{fmtDate(file.uploaded_at)}</td>
                    <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground truncate max-w-[180px]" title={file.uploaded_by_email || ""}>
                      {file.uploaded_by || file.uploaded_by_email || "—"}
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {data.can_edit && (
                          <button
                            type="button"
                            disabled={busyId === file.id}
                            onClick={() => setEditingFile(file)}
                            data-testid={`sop-edit-${file.id}`}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-50"
                          >
                            <PencilSimple size={15} /> Edit SOP
                          </button>
                        )}
                        {data.can_review && (
                          <button
                            type="button"
                            disabled={busyId === file.id}
                            onClick={() => transition(file, "review")}
                            data-testid={`sop-review-${file.id}`}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                          >
                            <ArrowRight size={15} /> Move to review
                          </button>
                        )}
                        {data.can_obsolete && (
                          <button
                            type="button"
                            disabled={busyId === file.id}
                            onClick={() => {
                              if (window.confirm(
                                `Mark "${file.filename}" as obsolete? It will leave the Approved master repository.`
                              )) transition(file, "obsolete");
                            }}
                            data-testid={`sop-obsolete-${file.id}`}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                          >
                            <Archive size={15} /> Mark Obsolete
                          </button>
                        )}
                        {VIEWABLE_EXTS.has(extOf(file.filename)) && (
                          <button type="button" title="View" disabled={busyId === file.id}
                            onClick={() => onView(file)}
                            className="rounded-md p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
                            data-testid={`sop-view-${file.id}`}>
                            <Eye size={17} />
                          </button>
                        )}
                        <button type="button" title="Download" disabled={busyId === file.id}
                          onClick={() => onDownload(file)}
                          className="rounded-md p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
                          data-testid={`sop-download-${file.id}`}>
                          <DownloadSimple size={17} />
                        </button>
                        {data.can_download_original && file.has_original && (
                          <button
                            type="button"
                            title="Download original upload"
                            disabled={busyId === file.id}
                            onClick={() => onDownloadOriginal(file)}
                            className="rounded-md px-2 py-1.5 hover:bg-muted text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                            data-testid={`sop-original-${file.id}`}
                          >
                            Original
                          </button>
                        )}
                        {data.can_delete && (
                          <button type="button" title="Delete" disabled={busyId === file.id}
                            onClick={() => onDelete(file)}
                            className="rounded-md p-1.5 hover:bg-red-50 text-muted-foreground hover:text-red-600 disabled:opacity-50"
                            data-testid={`sop-delete-${file.id}`}>
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
      {editingFile && (
        <SopEditorModal
          file={editingFile}
          onClose={() => setEditingFile(null)}
          onSaved={() => refresh()}
        />
      )}
    </div>
  );
};

const SOPs = () => {
  const { user } = useAuth();
  const isAdmin = (user?.role || "").toLowerCase() === "admin";
  const [stages, setStages] = useState(null);
  const [stageError, setStageError] = useState(null);
  const [selectedStage, setSelectedStage] = useState(null);
  const [departments, setDepartments] = useState(null);
  const [departmentError, setDepartmentError] = useState(null);
  const [selectedDepartment, setSelectedDepartment] = useState(null);
  const [adminDepartments, setAdminDepartments] = useState([]);

  const loadStages = useCallback(() => {
    api.get("/sops/stages", { forceFresh: true })
      .then((r) => { setStages(r.data || []); setStageError(null); })
      .catch((e) => setStageError(e?.response?.data?.detail || e.message));
  }, []);

  const loadDepartments = useCallback(() => {
    if (!selectedStage) return;
    api.get(`/sops/departments?stage=${selectedStage.id}`, { forceFresh: true })
      .then((r) => { setDepartments(r.data || []); setDepartmentError(null); })
      .catch((e) => setDepartmentError(e?.response?.data?.detail || e.message));
  }, [selectedStage]);

  useEffect(() => { loadStages(); }, [loadStages]);
  useEffect(() => {
    setDepartments(null);
    setSelectedDepartment(null);
    if (selectedStage) loadDepartments();
  }, [selectedStage, loadDepartments]);
  useEffect(() => {
    if (!isAdmin) return;
    api.get("/sops/departments?stage=1", { forceFresh: true })
      .then((r) => setAdminDepartments(r.data || []))
      .catch(() => setAdminDepartments([]));
  }, [isAdmin]);

  return (
    <div className="space-y-6" data-testid="sops-page">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Standard Operating Procedures</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Submit Word SOPs for review or browse approved PDFs in the master repository by department.
        </p>
      </div>

      {stageError && <ErrorBox message={stageError} />}
      {!stages && !stageError && <Loading label="Loading SOP workflow…" />}
      {stages && !selectedStage && <WorkflowStageGrid stages={stages} onOpen={setSelectedStage} />}

      {selectedStage && departmentError && <ErrorBox message={departmentError} />}
      {selectedStage && !departments && !departmentError && <Loading label="Loading department folders…" />}
      {selectedStage && departments && !selectedDepartment && (
        <WorkflowDepartmentGrid
          stage={selectedStage}
          departments={departments}
          onOpen={setSelectedDepartment}
          onBack={() => setSelectedStage(null)}
        />
      )}
      {selectedStage && selectedDepartment && (
        <WorkflowFolderView
          stage={selectedStage}
          dept={selectedDepartment}
          onBack={() => { setSelectedDepartment(null); loadDepartments(); }}
          onChanged={() => { loadStages(); loadDepartments(); }}
        />
      )}

      {isAdmin && adminDepartments.length > 0 && (
        <AdminGrantsPanel departments={adminDepartments} onChanged={loadStages} />
      )}
      {isAdmin && <FabricFieldGrantsPanel />}
    </div>
  );
};

const FIELD_LABELS = {
  width_edit: "After-wash Width (cm)",
  roll_no_edit: "Roll Number",
};

const FabricFieldGrantsPanel = () => {
  const [open, setOpen] = useState(false);
  const [grants, setGrants] = useState(null);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [selUser, setSelUser] = useState("");
  const [selField, setSelField] = useState("");

  const load = useCallback(() => {
    Promise.all([
      api.get("/admin/fabric-field-grants", { forceFresh: true }),
      api.get("/admin/users", { forceFresh: true }),
    ])
      .then(([g, u]) => {
        setGrants(Array.isArray(g.data) ? g.data : (g.data?.data || []));
        const list = Array.isArray(u.data) ? u.data : (u.data?.users || []);
        setUsers(list.filter((x) => (x.status || "") === "active"));
        setError(null);
      })
      .catch((e) => setError(e?.response?.data?.detail || e.message));
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const addGrant = async () => {
    if (!selUser || !selField) return;
    setSaving(true);
    try {
      await api.post("/admin/fabric-field-grants", { user_id: selUser, field_name: selField });
      setSelField("");
      load();
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    } finally {
      setSaving(false);
    }
  };

  const removeGrant = async (g) => {
    setSaving(true);
    try {
      await api.delete(`/admin/fabric-field-grants?user_id=${encodeURIComponent(g.user_id)}&field_name=${encodeURIComponent(g.field_name)}`);
      load();
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
        className="w-full flex items-center gap-2 p-4 text-left"
      >
        <ShieldCheck size={20} weight="duotone" className="text-primary" />
        <div>
          <div className="font-medium">Fabric receiving — field edit rights</div>
          <div className="text-xs text-muted-foreground">
            Grant specific users the right to edit After-wash Width or Roll Number on receiving sheets they created (admins can always edit everything).
          </div>
        </div>
        <span className="ml-auto text-xs text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="border-t p-4 space-y-4">
          {error && <ErrorBox message={error} />}
          {(!grants || !users) && !error && <Loading label="Loading grants…" />}
          {grants && users && (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-sm">
                  <div className="text-xs text-muted-foreground mb-1">User</div>
                  <select
                    value={selUser}
                    onChange={(e) => setSelUser(e.target.value)}
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
                  <div className="text-xs text-muted-foreground mb-1">Field</div>
                  <select
                    value={selField}
                    onChange={(e) => setSelField(e.target.value)}
                    className="rounded-lg border bg-background px-2.5 py-1.5 text-sm min-w-[200px]"
                  >
                    <option value="">Select a field…</option>
                    {Object.entries(FIELD_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={addGrant}
                  disabled={saving || !selUser || !selField}
                  className="rounded-lg bg-primary text-primary-foreground text-sm px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
                >
                  Grant access
                </button>
              </div>

              {grants.length === 0 ? (
                <Empty label="No field-edit grants yet — only admins can edit all fields." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b">
                        <th className="py-2 pr-3 font-medium">User</th>
                        <th className="py-2 pr-3 font-medium">Field</th>
                        <th className="py-2 pr-3 font-medium">Granted by</th>
                        <th className="py-2 pr-3 font-medium">Granted</th>
                        <th className="py-2 font-medium text-right">Revoke</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grants.map((g) => (
                        <tr key={`${g.user_id}|${g.field_name}`} className="border-b last:border-0">
                          <td className="py-2 pr-3">
                            <div className="truncate max-w-[260px]">{g.name || g.email || g.user_id}</div>
                            {g.email && g.name && (
                              <div className="text-xs text-muted-foreground truncate max-w-[260px]">{g.email}</div>
                            )}
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap">{FIELD_LABELS[g.field_name] || g.field_name}</td>
                          <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{g.granted_by || "—"}</td>
                          <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{fmtDate(g.granted_at)}</td>
                          <td className="py-2">
                            <div className="flex justify-end">
                              <button
                                type="button"
                                title="Revoke"
                                disabled={saving}
                                onClick={() => removeGrant(g)}
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
