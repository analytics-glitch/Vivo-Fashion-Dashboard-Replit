import React, { useEffect, useRef, useState } from "react";
import { api, timeAgo } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Sparkles, RefreshCw, Plus, Star, Heart, MessageCircle, Archive, ArchiveRestore,
  ArrowUp, ArrowDown, Trash2, ImagePlus, Pencil, X, Calendar,
} from "lucide-react";

// Staff management for "Vivo Edits" — curated shoppable member edits shown in the
// community app. Backend: /api/crm/community-edits* (staff-gated). Public image
// route /api/community/edit-image/{img_id} is used directly in <img src>.

const MAX_IMG_BYTES = 3 * 1024 * 1024;

// FileReader -> bare base64 (strip the "data:...;base64," prefix the API rejects).
function fileToBareBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// datetime-local <-> ISO helpers. Input value is local wall-clock without tz;
// we send a full ISO string (with tz offset) or null.
function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function scheduleLabel(edit) {
  const s = edit.starts_at ? new Date(edit.starts_at) : null;
  const e = edit.ends_at ? new Date(edit.ends_at) : null;
  const fmt = (d) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  if (!s && !e) return "Always visible";
  if (s && e) return `${fmt(s)} → ${fmt(e)}`;
  if (s) return `From ${fmt(s)}`;
  return `Until ${fmt(e)}`;
}

const emptyForm = {
  creator_name: "",
  creator_username: "",
  title: "",
  description: "",
  intro: "",
  disclosure: "",
  featured: false,
  starts_at: "",
  ends_at: "",
  skus: "",
};

export default function VivoEdits() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(null);

  // Create / edit dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null); // full edit object when editing, null when creating
  const [form, setForm] = useState(emptyForm);
  const [newImages, setNewImages] = useState([]); // [{image_b64, alt_text, name, preview}]
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get("/crm/community-edits");
      setItems(data.items || []);
    } catch (e) {
      setError(e?.response?.data?.detail || "Couldn't load Vivo Edits");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const active = items.filter((it) => !it.archived_at);
  const archived = items.filter((it) => it.archived_at);
  const shown = showArchived ? archived : active;

  /* ---------- Create / edit form ---------- */

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setNewImages([]);
    setDialogOpen(true);
  };

  const openEdit = (it) => {
    setEditing(it);
    setForm({
      creator_name: it.creator_name || "",
      creator_username: it.creator_username || "",
      title: it.title || "",
      description: it.description || "",
      intro: it.intro || "",
      disclosure: it.disclosure || "",
      featured: !!it.featured,
      starts_at: isoToLocalInput(it.starts_at),
      ends_at: isoToLocalInput(it.ends_at),
      skus: (it.tagged || []).map((t) => t.sku).join(", "),
    });
    setNewImages([]);
    setDialogOpen(true);
  };

  const onPickFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // allow re-selecting the same file
    for (const f of files) {
      if (!/^image\/(png|jpe?g)$/i.test(f.type)) {
        toast.error(`${f.name}: only PNG or JPEG allowed`);
        continue;
      }
      if (f.size > MAX_IMG_BYTES) {
        toast.error(`${f.name}: image must be under 3MB`);
        continue;
      }
      try {
        const b64 = await fileToBareBase64(f);
        setNewImages((prev) => [
          ...prev,
          { image_b64: b64, alt_text: "", name: f.name, preview: URL.createObjectURL(f) },
        ]);
      } catch {
        toast.error(`${f.name}: couldn't read the file`);
      }
    }
  };

  const removeNewImage = (idx) => {
    setNewImages((prev) => {
      const next = [...prev];
      if (next[idx]?.preview) URL.revokeObjectURL(next[idx].preview);
      next.splice(idx, 1);
      return next;
    });
  };

  const parseSkus = (raw) =>
    raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

  const save = async () => {
    if (!form.creator_name.trim() || !form.title.trim()) {
      toast.error("Creator name and title are required");
      return;
    }
    setSaving(true);
    try {
      const skus = parseSkus(form.skus);
      const payload = {
        creator_name: form.creator_name.trim(),
        creator_username: form.creator_username.trim() || null,
        title: form.title.trim(),
        description: form.description.trim() || null,
        intro: form.intro.trim() || null,
        disclosure: form.disclosure.trim() || null,
        featured: form.featured,
        starts_at: localInputToIso(form.starts_at),
        ends_at: localInputToIso(form.ends_at),
        skus,
      };
      if (editing) {
        await api.put(`/crm/community-edits/${editing.id}`, payload);
        // Upload any newly added images (first upload becomes cover only if the
        // edit has none yet; staff can promote a cover explicitly from the card).
        const hadImages = (editing.images || []).length > 0;
        for (let i = 0; i < newImages.length; i++) {
          const img = newImages[i];
          await api.post(`/crm/community-edits/${editing.id}/images`, {
            image_b64: img.image_b64,
            alt_text: img.alt_text || null,
            cover: !hadImages && i === 0,
          });
        }
        toast.success("Edit updated");
      } else {
        payload.images = newImages.map((img) => ({
          image_b64: img.image_b64,
          alt_text: img.alt_text || null,
        }));
        await api.post("/crm/community-edits", payload);
        toast.success("Edit created");
      }
      setDialogOpen(false);
      await load();
    } catch (e) {
      // Surface the backend's Unknown SKUs (and other 400) messages verbatim.
      toast.error(e?.response?.data?.detail || e?.response?.data?.message || "Couldn't save the edit");
    } finally {
      setSaving(false);
    }
  };

  /* ---------- Card-level mutations ---------- */

  const setArchived = async (it, archived) => {
    setBusy(it.id);
    try {
      await api.put(`/crm/community-edits/${it.id}`, { archived });
      toast.success(archived ? "Edit archived — hidden from the app" : "Edit restored");
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const toggleFeatured = async (it) => {
    setBusy(it.id);
    try {
      await api.put(`/crm/community-edits/${it.id}`, { featured: !it.featured });
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Update failed");
    } finally {
      setBusy(null);
    }
  };

  // Reorder within the active list: swap and PUT the full active-ids order.
  const move = async (it, dir) => {
    const ids = active.map((a) => a.id);
    const idx = ids.indexOf(it.id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
    setBusy(it.id);
    try {
      await api.put("/crm/community-edits/reorder", { ids });
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't reorder");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-6 md:p-10 max-w-[1200px] mx-auto space-y-4" data-testid="vivo-edits-page">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="eyebrow">Community · Vivo Edits</div>
          <h1 className="font-display text-4xl md:text-5xl tracking-tight mt-2 flex items-center gap-3">
            <Sparkles className="h-8 w-8 text-[var(--vivo-primary)]" /> Vivo Edits
          </h1>
          <div className="gold-rule mt-4" />
          <p className="text-sm text-[var(--vivo-muted)] mt-3 max-w-2xl">
            Curated, shoppable creator edits shown in the community app. Order active edits,
            feature the standouts, schedule a window, and archive anything you want off the app
            without losing it here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} data-testid="ve-refresh">
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button onClick={openCreate} className="bg-[var(--vivo-navy)] hover:bg-[var(--vivo-navy-700)] text-white rounded-sm" data-testid="ve-new">
            <Plus className="mr-2 h-4 w-4" /> New edit
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap" data-testid="ve-tabs">
        <button
          onClick={() => setShowArchived(false)}
          className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
            !showArchived
              ? "bg-[var(--vivo-ink)] text-white border-[var(--vivo-ink)]"
              : "bg-white text-[var(--vivo-muted)] border-[var(--vivo-border)] hover:text-[var(--vivo-ink)]"
          }`}
          data-testid="ve-tab-active"
        >
          Active <span className="ml-1.5 opacity-70">{active.length}</span>
        </button>
        <button
          onClick={() => setShowArchived(true)}
          className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
            showArchived
              ? "bg-[var(--vivo-ink)] text-white border-[var(--vivo-ink)]"
              : "bg-white text-[var(--vivo-muted)] border-[var(--vivo-border)] hover:text-[var(--vivo-ink)]"
          }`}
          data-testid="ve-tab-archived"
        >
          Archived <span className="ml-1.5 opacity-70">{archived.length}</span>
        </button>
      </div>

      {error ? (
        <Card className="p-8 text-center" data-testid="ve-error">
          <p className="text-sm text-red-600">{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button>
        </Card>
      ) : loading ? (
        <Card className="p-10 text-center text-sm text-[var(--vivo-muted)]">Loading edits…</Card>
      ) : shown.length === 0 ? (
        <Card className="p-10 text-center" data-testid="ve-empty">
          <Sparkles className="h-8 w-8 mx-auto text-[var(--vivo-muted)] opacity-40 mb-3" />
          <p className="text-sm text-[var(--vivo-muted)]">
            {showArchived ? "Nothing archived." : "No edits yet — create the first one."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((it, idx) => (
            <Card key={it.id} className="p-4" data-testid={`ve-item-${it.id}`}>
              <div className="flex items-start gap-4 flex-wrap md:flex-nowrap">
                {/* Cover thumbnail — public image route, used directly */}
                <div className="w-28 h-28 shrink-0 rounded overflow-hidden border border-[var(--vivo-border)] bg-[var(--vivo-bg)] flex items-center justify-center">
                  {it.cover_image ? (
                    <img
                      src={it.cover_image}
                      alt={it.title || "Edit cover"}
                      className="w-full h-full object-cover"
                      data-testid={`ve-cover-${it.id}`}
                    />
                  ) : (
                    <ImagePlus className="h-6 w-6 text-[var(--vivo-muted)] opacity-40" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-[var(--vivo-ink)] truncate">{it.title}</span>
                    {it.featured && (
                      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                        <Star className="h-3 w-3 mr-1" /> Featured
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={it.is_active
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-slate-100 text-slate-600"}
                      data-testid={`ve-status-${it.id}`}
                    >
                      {it.archived_at ? "Archived" : it.is_active ? "Live" : "Scheduled/hidden"}
                    </Badge>
                  </div>

                  <p className="text-xs text-[var(--vivo-muted)] mt-1">
                    {it.creator_name}{it.creator_username ? ` · @${it.creator_username}` : ""}
                  </p>
                  {it.description && (
                    <p className="text-sm text-[var(--vivo-ink)] mt-1 line-clamp-2">{it.description}</p>
                  )}

                  <div className="mt-2 flex items-center gap-3 flex-wrap text-xs text-[var(--vivo-muted)]">
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="h-3.5 w-3.5" /> {scheduleLabel(it)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Heart className="h-3.5 w-3.5" /> {it.like_count || 0}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <MessageCircle className="h-3.5 w-3.5" /> {it.comment_count || 0}
                    </span>
                    {Array.isArray(it.tagged) && it.tagged.length > 0 && (
                      <span>{it.tagged.length} product{it.tagged.length === 1 ? "" : "s"} tagged</span>
                    )}
                    {Array.isArray(it.images) && (
                      <span>{it.images.length} image{it.images.length === 1 ? "" : "s"}</span>
                    )}
                    {it.created_at && <span>added {timeAgo(it.created_at)}</span>}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col items-end gap-2 shrink-0">
                  {!it.archived_at && (
                    <div className="flex items-center gap-1">
                      <Button size="icon" variant="outline" className="h-7 w-7"
                        disabled={busy === it.id || idx === 0}
                        onClick={() => move(it, -1)} data-testid={`ve-up-${it.id}`} aria-label="Move up">
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="outline" className="h-7 w-7"
                        disabled={busy === it.id || idx === shown.length - 1}
                        onClick={() => move(it, 1)} data-testid={`ve-down-${it.id}`} aria-label="Move down">
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    {!it.archived_at && (
                      <Button size="sm" variant="outline" disabled={busy === it.id}
                        onClick={() => toggleFeatured(it)} data-testid={`ve-feature-${it.id}`}>
                        <Star className={`h-3.5 w-3.5 mr-1 ${it.featured ? "fill-amber-400 text-amber-500" : ""}`} />
                        {it.featured ? "Unfeature" : "Feature"}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => openEdit(it)} data-testid={`ve-edit-${it.id}`}>
                      <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                    </Button>
                    {it.archived_at ? (
                      <Button size="sm" variant="outline" disabled={busy === it.id}
                        onClick={() => setArchived(it, false)} data-testid={`ve-restore-${it.id}`}>
                        <ArchiveRestore className="h-3.5 w-3.5 mr-1" /> Restore
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={busy === it.id}
                        onClick={() => setArchived(it, true)} data-testid={`ve-archive-${it.id}`}>
                        <Archive className="h-3.5 w-3.5 mr-1" /> Archive
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <EditDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        form={form}
        setForm={setForm}
        newImages={newImages}
        setNewImages={setNewImages}
        removeNewImage={removeNewImage}
        onPickFiles={onPickFiles}
        fileRef={fileRef}
        saving={saving}
        onSave={save}
        onChanged={load}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create / edit dialog. On edit, existing images can be deleted or a  */
/* new cover promoted; those hit the images endpoints and refresh.     */
/* ------------------------------------------------------------------ */

function EditDialog({
  open, onOpenChange, editing, form, setForm, newImages, setNewImages,
  removeNewImage, onPickFiles, fileRef, saving, onSave, onChanged,
}) {
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const [imgBusy, setImgBusy] = useState(null);

  const deleteExisting = async (imgId) => {
    setImgBusy(imgId);
    try {
      await api.delete(`/crm/community-edits/${editing.id}/images/${imgId}`);
      toast.success("Image removed");
      await onChanged();
      onOpenChange(false); // reopen edit to reload the fresh image list
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't remove image");
    } finally {
      setImgBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="ve-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Vivo Edit" : "New Vivo Edit"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label>Creator name *</Label>
              <Input value={form.creator_name} onChange={set("creator_name")} placeholder="Wanjiru M." data-testid="ve-f-creator-name" />
            </div>
            <div>
              <Label>Creator username</Label>
              <Input value={form.creator_username} onChange={set("creator_username")} placeholder="wanjiru" data-testid="ve-f-creator-username" />
            </div>
          </div>

          <div>
            <Label>Title *</Label>
            <Input value={form.title} onChange={set("title")} placeholder="Weekend layers" data-testid="ve-f-title" />
          </div>

          <div>
            <Label>Description</Label>
            <Textarea rows={2} value={form.description} onChange={set("description")} data-testid="ve-f-description" />
          </div>

          <div>
            <Label>Intro</Label>
            <Textarea rows={2} value={form.intro} onChange={set("intro")} placeholder="Longer intro shown on the edit page" data-testid="ve-f-intro" />
          </div>

          <div>
            <Label>Disclosure</Label>
            <Input value={form.disclosure} onChange={set("disclosure")} placeholder="Gifted / paid partnership" data-testid="ve-f-disclosure" />
          </div>

          <div className="flex items-center gap-3">
            <Switch checked={form.featured} onCheckedChange={(v) => setForm((f) => ({ ...f, featured: v }))} data-testid="ve-f-featured" />
            <Label className="cursor-pointer" onClick={() => setForm((f) => ({ ...f, featured: !f.featured }))}>Featured</Label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label>Starts at</Label>
              <Input type="datetime-local" value={form.starts_at} onChange={set("starts_at")} data-testid="ve-f-starts" />
            </div>
            <div>
              <Label>Ends at</Label>
              <Input type="datetime-local" value={form.ends_at} onChange={set("ends_at")} data-testid="ve-f-ends" />
            </div>
          </div>

          <div>
            <Label>Tagged product SKUs</Label>
            <Textarea
              rows={2}
              value={form.skus}
              onChange={set("skus")}
              placeholder="Comma or space separated, e.g. SKU-001, SKU-002"
              data-testid="ve-f-skus"
            />
            <p className="text-xs text-[var(--vivo-muted)] mt-1">Unknown SKUs are rejected — the error will name them.</p>
          </div>

          {/* Existing images (edit mode) */}
          {editing && (editing.images || []).length > 0 && (
            <div>
              <Label>Current images</Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {(editing.images || []).map((img, i) => (
                  <div key={img.id} className="relative w-24" data-testid={`ve-existing-img-${img.id}`}>
                    <img
                      src={`/api/community/edit-image/${img.id}`}
                      alt={img.alt_text || `Image ${i + 1}`}
                      className="w-24 h-24 object-cover rounded border border-[var(--vivo-border)]"
                    />
                    {i === 0 && (
                      <span className="absolute top-1 left-1 text-[9px] bg-[var(--vivo-ink)] text-white px-1 rounded">Cover</span>
                    )}
                    <button
                      type="button"
                      onClick={() => deleteExisting(img.id)}
                      disabled={imgBusy === img.id}
                      className="absolute -top-2 -right-2 bg-white border border-[var(--vivo-border)] rounded-full p-0.5 text-red-600 hover:bg-red-50"
                      data-testid={`ve-del-img-${img.id}`}
                      aria-label="Delete image"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-xs text-[var(--vivo-muted)] mt-1">
                The first image is the cover. Upload a new image below marked as cover to change it.
              </p>
            </div>
          )}

          {/* New image uploads */}
          <div>
            <Label>{editing ? "Add images" : "Images"}</Label>
            <div className="mt-1">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                multiple
                onChange={onPickFiles}
                className="hidden"
                data-testid="ve-f-file"
              />
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} data-testid="ve-f-add-images">
                <ImagePlus className="h-3.5 w-3.5 mr-1" /> Choose images
              </Button>
              <span className="ml-2 text-xs text-[var(--vivo-muted)]">PNG / JPEG, under 3MB{!editing ? ". First = cover." : ""}</span>
            </div>
            {newImages.length > 0 && (
              <div className="space-y-2 mt-2">
                {newImages.map((img, i) => (
                  <div key={i} className="flex items-center gap-2" data-testid={`ve-new-img-${i}`}>
                    <img src={img.preview} alt={img.name} className="w-16 h-16 object-cover rounded border border-[var(--vivo-border)]" />
                    <div className="flex-1 min-w-0">
                      {!editing && i === 0 && <div className="text-[10px] text-[var(--vivo-ink)] font-medium">Cover</div>}
                      <Input
                        value={img.alt_text}
                        onChange={(e) => setNewImages((prev) => prev.map((p, pi) => pi === i ? { ...p, alt_text: e.target.value } : p))}
                        placeholder="Alt text"
                        className="h-8 text-sm"
                        data-testid={`ve-new-img-alt-${i}`}
                      />
                    </div>
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-red-600"
                      onClick={() => removeNewImage(i)} aria-label="Remove">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={onSave} disabled={saving} className="bg-[var(--vivo-navy)] hover:bg-[var(--vivo-navy-700)] text-white" data-testid="ve-f-save">
            {saving ? "Saving…" : editing ? "Save changes" : "Create edit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
