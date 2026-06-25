import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/api";
import { invalidateThumbnail, primeThumbnail } from "@/lib/useThumbnails";
import { SectionTitle, Loading, ErrorBox, Empty } from "@/components/common";
import { toast } from "sonner";
import {
  ArrowsClockwise,
  MagnifyingGlass,
  Pencil,
  Trash,
  X,
  WarningCircle,
  CheckCircle,
  Image as ImageIcon,
} from "@phosphor-icons/react";

// ─── inline editor (reuses POST/DELETE /thumbnails/{style}) ──────────────────
const Editor = ({ row, onClose, onChanged }) => {
  const style = row.style_name;
  const [url, setUrl] = useState(row.image_url || "");
  const [preview, setPreview] = useState(row.image_url || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      toast.error("Paste a full https:// URL");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/thumbnails/${encodeURIComponent(style)}`, {
        style_name: style,
        image_url: trimmed,
      });
      primeThumbnail(style, trimmed);
      toast.success("Photo updated");
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save — check the URL");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
      data-testid="thumb-mgr-editor-backdrop"
    >
      <div className="card-white p-5 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted">Custom style photo</div>
            <div className="font-semibold text-[15px] mt-0.5 break-words">{style}</div>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-panel" data-testid="thumb-mgr-editor-close">
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center gap-4">
          <div className="rounded-lg overflow-hidden border border-border bg-panel grid place-items-center" style={{ width: 96, height: 96 }}>
            {preview ? (
              <img src={preview} alt="preview" className="w-full h-full object-cover" onError={() => setPreview("")} />
            ) : (
              <ImageIcon size={28} className="text-muted" />
            )}
          </div>
          <div className="flex-1 space-y-2">
            <label className="text-[11px] uppercase tracking-wider text-muted">Image URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setPreview(e.target.value.trim()); }}
              placeholder="https://cdn.example.com/sku.jpg"
              className="w-full border border-border rounded px-2 py-1.5 text-[13px] outline-none focus:border-brand"
              data-testid="thumb-mgr-editor-url"
              autoFocus
            />
            <p className="text-[10.5px] text-muted">
              Must be a direct https:// link to a web-safe image (JPG/PNG/WebP).
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="text-[12px] px-3 py-1.5 rounded hover:bg-panel">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !url.trim()}
            className="text-[12px] px-3 py-1.5 rounded bg-brand text-white hover:bg-brand-deep disabled:opacity-40"
            data-testid="thumb-mgr-editor-save"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── thumbnail cell with broken-link detection ───────────────────────────────
const Thumb = ({ url, style, onStatus }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  if (!url || failed) {
    return (
      <div
        className="rounded-md border border-border bg-panel grid place-items-center text-muted shrink-0"
        style={{ width: 48, height: 48 }}
        title={url ? "Image failed to load" : "No URL"}
      >
        <WarningCircle size={18} className="text-amber-500" />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={style}
      loading="lazy"
      className="rounded-md border border-border object-cover shrink-0"
      style={{ width: 48, height: 48 }}
      onLoad={() => onStatus?.(style, "ok")}
      onError={() => { setFailed(true); onStatus?.(style, "broken"); }}
    />
  );
};

/**
 * Custom Style Photos (admin-only).
 *
 * Lists every admin-set thumbnail override from GET /api/thumbnails so admins
 * can see at a glance which styles have manual photos, spot broken links, edit
 * the URL, or remove stale overrides — instead of stumbling on them one style
 * at a time in the product tables.
 */
const ThumbnailManager = () => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState({}); // style -> bool
  const [status, setStatus] = useState({}); // style -> "ok" | "broken"

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .get("/thumbnails", { forceFresh: true })
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e?.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const onStatus = useCallback((style, st) => {
    setStatus((prev) => (prev[style] === st ? prev : { ...prev, [style]: st }));
  }, []);

  const remove = async (style) => {
    if (!window.confirm(`Remove the custom photo for "${style}"? The style will fall back to its placeholder.`)) return;
    setRemoving((p) => ({ ...p, [style]: true }));
    try {
      await api.delete(`/thumbnails/${encodeURIComponent(style)}`);
      invalidateThumbnail(style);
      setRows((prev) => prev.filter((r) => r.style_name !== style));
      toast.success("Photo removed");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't remove");
    } finally {
      setRemoving((p) => ({ ...p, [style]: false }));
    }
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      (r.style_name || "").toLowerCase().includes(needle) ||
      (r.updated_by || "").toLowerCase().includes(needle)
    );
  }, [rows, q]);

  const brokenCount = useMemo(
    () => filtered.filter((r) => status[r.style_name] === "broken").length,
    [filtered, status]
  );

  return (
    <div className="space-y-5" data-testid="thumbnail-manager-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <SectionTitle
          title="Custom Style Photos"
          subtitle="Review and manage every manually-set product photo across the dashboard"
        />
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand text-white font-semibold text-[13px] hover:bg-brand-deep shrink-0"
          data-testid="thumbnail-manager-refresh"
        >
          <ArrowsClockwise size={14} weight="bold" /> Refresh
        </button>
      </div>

      <div className="card-white p-4 border-l-4 border-l-sky-400 bg-sky-50/40 text-[12.5px] text-muted">
        These are the custom photos admins have attached to styles from the product tables. Each one
        overrides the auto-generated placeholder everywhere that style appears. A{" "}
        <b className="text-amber-600">broken</b> badge means the image URL could not be loaded — edit
        or remove it so users don't see a missing image.
      </div>

      {loading && <Loading />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="pill-neutral inline-flex items-center gap-1">
              <ImageIcon size={12} /> {rows.length} custom {rows.length === 1 ? "photo" : "photos"}
            </span>
            {brokenCount > 0 ? (
              <span className="pill-red inline-flex items-center gap-1">
                <WarningCircle size={12} weight="fill" /> {brokenCount} broken
              </span>
            ) : rows.length > 0 ? (
              <span className="pill-green inline-flex items-center gap-1">
                <CheckCircle size={12} weight="fill" /> all loading
              </span>
            ) : null}
            <div className="relative ml-auto">
              <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search style or who set it…"
                className="border border-border rounded-lg pl-8 pr-2 py-1.5 text-[12.5px] outline-none focus:border-brand w-64 max-w-full"
                data-testid="thumbnail-manager-search"
              />
            </div>
          </div>

          {rows.length === 0 ? (
            <Empty label="No custom photos yet. Admins can attach one from any product table." />
          ) : filtered.length === 0 ? (
            <Empty label="No photos match your search." />
          ) : (
            <div className="card-white p-0 overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-muted text-left border-b border-border">
                    <th className="py-2.5 px-4 font-semibold">Photo</th>
                    <th className="py-2.5 px-2 font-semibold">Style</th>
                    <th className="py-2.5 px-2 font-semibold">Set by</th>
                    <th className="py-2.5 px-2 font-semibold">Updated</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const broken = status[r.style_name] === "broken";
                    return (
                      <tr
                        key={r.style_name}
                        className="border-b border-border/60 align-middle"
                        data-testid={`thumb-row-${r.style_name}`}
                      >
                        <td className="py-2.5 px-4">
                          <Thumb url={r.image_url} style={r.style_name} onStatus={onStatus} />
                        </td>
                        <td className="py-2.5 px-2">
                          <div className="font-semibold break-words max-w-[260px]">{r.style_name}</div>
                          <a
                            href={r.image_url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-[10.5px] text-muted hover:text-brand break-all line-clamp-1 max-w-[320px] inline-block"
                            title={r.image_url}
                          >
                            {r.image_url}
                          </a>
                          {broken && (
                            <span className="pill-red inline-flex items-center gap-1 ml-0 mt-1 text-[10.5px]">
                              <WarningCircle size={10} weight="fill" /> broken link
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-2 text-muted">{r.updated_by || "—"}</td>
                        <td className="py-2.5 px-2 text-muted whitespace-nowrap">
                          {r.updated_at ? fmtDate(r.updated_at) : "—"}
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setEditing(r)}
                              className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded hover:bg-panel"
                              data-testid={`thumb-edit-${r.style_name}`}
                            >
                              <Pencil size={13} /> Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(r.style_name)}
                              disabled={removing[r.style_name]}
                              className="inline-flex items-center gap-1 text-[12px] text-red-700 hover:bg-red-50 px-2 py-1 rounded disabled:opacity-40"
                              data-testid={`thumb-remove-${r.style_name}`}
                            >
                              <Trash size={13} /> {removing[r.style_name] ? "Removing…" : "Remove"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {editing && (
        <Editor
          row={editing}
          onClose={() => setEditing(null)}
          onChanged={() => {
            // Reflect the edit locally + clear any stale broken flag.
            setRows((prev) => prev.map((x) => x.style_name === editing.style_name ? { ...x } : x));
            setStatus((prev) => {
              const next = { ...prev };
              delete next[editing.style_name];
              return next;
            });
            load();
          }}
        />
      )}
    </div>
  );
};

export default ThumbnailManager;
