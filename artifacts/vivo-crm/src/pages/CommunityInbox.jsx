import React, { useEffect, useState } from "react";
import { api, timeAgo } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  MessagesSquare, RefreshCw, Phone, Mail, ImageIcon, CheckCircle2,
  Timer, Undo2, UserRound,
} from "lucide-react";

// Messages members send from the community app's Contact Us form.
// Backend: /api/crm/community-contact* (staff-gated like the rest of /api/crm).

const STATUS_TABS = [
  ["all", "All"],
  ["new", "New"],
  ["in_progress", "In progress"],
  ["resolved", "Resolved"],
];

const STATUS_STYLE = {
  new: "bg-amber-50 text-amber-700 border-amber-200",
  in_progress: "bg-blue-50 text-blue-700 border-blue-200",
  resolved: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

const STATUS_LABEL = { new: "New", in_progress: "In progress", resolved: "Resolved" };

export default function CommunityInbox() {
  const [status, setStatus] = useState("all");
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [photos, setPhotos] = useState({}); // id -> objectURL (loaded on demand)
  const [notes, setNotes] = useState({}); // id -> draft note
  const [busy, setBusy] = useState(null);

  const load = async (st = status) => {
    setLoading(true);
    try {
      const { data } = await api.get("/crm/community-contact", {
        params: st === "all" ? {} : { status: st },
      });
      setItems(data.items || []);
      setCounts(data.counts || {});
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load community messages");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const patch = async (id, body, okMsg) => {
    setBusy(id);
    try {
      await api.patch(`/crm/community-contact/${id}`, body);
      toast.success(okMsg);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const togglePhoto = async (id) => {
    if (photos[id]) {
      setPhotos((p) => {
        const next = { ...p };
        URL.revokeObjectURL(next[id]);
        delete next[id];
        return next;
      });
      return;
    }
    try {
      const { data } = await api.get(`/crm/community-contact/${id}/photo`, { responseType: "blob" });
      setPhotos((p) => ({ ...p, [id]: URL.createObjectURL(data) }));
    } catch {
      toast.error("Couldn't load the photo");
    }
  };

  const total = (counts.new || 0) + (counts.in_progress || 0) + (counts.resolved || 0);
  const countFor = (id) => (id === "all" ? total : counts[id] || 0);

  return (
    <div className="space-y-4" data-testid="community-inbox-page">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-[var(--vivo-ink)] flex items-center gap-2">
            <MessagesSquare className="h-5 w-5 text-[var(--vivo-primary)]" /> Community Inbox
          </h1>
          <p className="text-sm text-[var(--vivo-muted)] mt-0.5">
            Messages members send from the community app's Contact Us form. Reply by phone,
            WhatsApp or email — their contact details are on each message.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading} data-testid="ci-refresh">
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap" data-testid="ci-tabs">
        {STATUS_TABS.map(([id, label]) => (
          <button
            key={id}
            data-testid={`ci-tab-${id}`}
            onClick={() => setStatus(id)}
            className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
              status === id
                ? "bg-[var(--vivo-ink)] text-white border-[var(--vivo-ink)]"
                : "bg-white text-[var(--vivo-muted)] border-[var(--vivo-border)] hover:text-[var(--vivo-ink)]"
            }`}
          >
            {label}
            <span className="ml-1.5 opacity-70">{countFor(id)}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <Card className="p-10 text-center text-sm text-[var(--vivo-muted)]">Loading messages…</Card>
      ) : items.length === 0 ? (
        <Card className="p-10 text-center" data-testid="ci-empty">
          <MessagesSquare className="h-8 w-8 mx-auto text-[var(--vivo-muted)] opacity-40 mb-3" />
          <p className="text-sm text-[var(--vivo-muted)]">
            {status === "all" ? "No messages yet — when members write in from the app, they land here." : "Nothing in this bucket right now."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((it) => (
            <Card key={it.id} className="p-4" data-testid={`ci-item-${it.id}`}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="font-medium">{it.subject_label}</Badge>
                  <Badge variant="outline" className={STATUS_STYLE[it.status] || ""} data-testid={`ci-status-${it.id}`}>
                    {STATUS_LABEL[it.status] || it.status}
                  </Badge>
                  <span className="text-xs text-[var(--vivo-muted)]">{timeAgo(it.created_at)}</span>
                </div>
                <div className="flex items-center gap-2">
                  {it.status !== "in_progress" && it.status !== "resolved" && (
                    <Button size="sm" variant="outline" disabled={busy === it.id}
                      onClick={() => patch(it.id, { status: "in_progress" }, "Marked in progress")}
                      data-testid={`ci-progress-${it.id}`}>
                      <Timer className="h-3.5 w-3.5 mr-1" /> In progress
                    </Button>
                  )}
                  {it.status !== "resolved" ? (
                    <Button size="sm" disabled={busy === it.id}
                      onClick={() => patch(it.id, { status: "resolved" }, "Resolved — nice one")}
                      data-testid={`ci-resolve-${it.id}`}>
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Resolve
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={busy === it.id}
                      onClick={() => patch(it.id, { status: "new" }, "Reopened")}
                      data-testid={`ci-reopen-${it.id}`}>
                      <Undo2 className="h-3.5 w-3.5 mr-1" /> Reopen
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2 text-sm text-[var(--vivo-ink)] flex-wrap" data-testid={`ci-member-${it.id}`}>
                <UserRound className="h-4 w-4 text-[var(--vivo-muted)]" />
                <span className="font-medium">{it.full_name}</span>
                <span className="text-[var(--vivo-muted)]">@{it.username}</span>
                {it.phone && (
                  <a href={`tel:${it.phone}`} className="inline-flex items-center gap-1 text-[var(--vivo-primary)] hover:underline">
                    <Phone className="h-3.5 w-3.5" /> {it.phone}
                  </a>
                )}
                {it.email && (
                  <a href={`mailto:${it.email}`} className="inline-flex items-center gap-1 text-[var(--vivo-primary)] hover:underline">
                    <Mail className="h-3.5 w-3.5" /> {it.email}
                  </a>
                )}
              </div>

              <p className="mt-2 text-sm text-[var(--vivo-ink)] whitespace-pre-wrap leading-relaxed" data-testid={`ci-message-${it.id}`}>
                {it.message}
              </p>

              {it.has_photo && (
                <div className="mt-3">
                  <Button size="sm" variant="outline" onClick={() => togglePhoto(it.id)} data-testid={`ci-photo-btn-${it.id}`}>
                    <ImageIcon className="h-3.5 w-3.5 mr-1" /> {photos[it.id] ? "Hide photo" : "View photo"}
                  </Button>
                  {photos[it.id] && (
                    <img
                      src={photos[it.id]}
                      alt="Member attachment"
                      className="mt-2 max-h-80 rounded border border-[var(--vivo-border)]"
                      data-testid={`ci-photo-${it.id}`}
                    />
                  )}
                </div>
              )}

              <div className="mt-3 flex items-end gap-2">
                <Textarea
                  rows={1}
                  placeholder="Internal note (what was done, who called back…)"
                  value={notes[it.id] ?? it.staff_note ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [it.id]: e.target.value }))}
                  className="text-sm min-h-[38px]"
                  data-testid={`ci-note-${it.id}`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === it.id || (notes[it.id] ?? it.staff_note ?? "") === (it.staff_note ?? "")}
                  onClick={() => patch(it.id, { staff_note: notes[it.id] ?? "" }, "Note saved")}
                  data-testid={`ci-note-save-${it.id}`}
                >
                  Save note
                </Button>
              </div>

              {it.handled_by && (
                <p className="mt-2 text-xs text-[var(--vivo-muted)]">Last handled by {it.handled_by}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
