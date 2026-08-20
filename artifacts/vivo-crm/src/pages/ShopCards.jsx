import React, { useEffect, useRef, useState } from "react";
import { ImagePlus, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function imageError(error, fallback = "Couldn't update this Shop card") {
  return error?.response?.data?.detail || error?.message || fallback;
}

function ShopCardEditor({ card, onChanged }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const choose = () => fileRef.current?.click();
  const upload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error("Choose a JPEG, PNG, GIF or WebP image.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("Image is too large — the limit is 5 MB.");
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      await api.post(`/crm/community-shop-cards/${card.id}`, body);
      toast.success(`${card.label} image updated`);
      setPreview("");
      await onChanged();
    } catch (error) {
      toast.error(imageError(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.delete(`/crm/community-shop-cards/${card.id}`);
      toast.success(`${card.label} image removed — the Shop fallback is now shown`);
      await onChanged();
    } catch (error) {
      toast.error(imageError(error, "Couldn't remove this image"));
    } finally {
      setBusy(false);
    }
  };

  const imageUrl = preview || card.image_url;
  return (
    <Card className="overflow-hidden" data-testid={`shop-card-editor-${card.id}`}>
      <div className="grid sm:grid-cols-[190px_1fr]">
        <div className="relative aspect-[5/4] sm:aspect-auto min-h-[170px] bg-[var(--vivo-bg)]">
          {imageUrl ? (
            <img src={imageUrl} alt={`${card.label} Shop card`} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[var(--vivo-muted)]">
              <ImagePlus className="h-7 w-7 opacity-45" />
              <span className="text-xs">Fallback treatment active</span>
            </div>
          )}
        </div>
        <div className="p-5 flex flex-col justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Community Shop shortcut</div>
            <h2 className="font-display text-xl text-[var(--vivo-navy)] mt-1">{card.label}</h2>
            <p className="text-xs text-[var(--vivo-muted)] mt-2">
              {card.updated_at
                ? `Updated ${new Date(card.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}${card.uploaded_by_name ? ` by ${card.uploaded_by_name}` : ""}.`
                : "No active image. Shoppers see the built-in editorial fallback."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              aria-label={`Choose an image for ${card.label}`}
              onChange={upload}
              disabled={busy}
            />
            <Button type="button" variant="outline" onClick={choose} disabled={busy} data-testid={`shop-card-upload-${card.id}`}>
              <UploadCloud className="h-3.5 w-3.5 mr-1.5" /> {card.image_url ? "Replace image" : "Upload image"}
            </Button>
            {card.image_url && (
              <Button type="button" variant="outline" onClick={remove} disabled={busy} data-testid={`shop-card-remove-${card.id}`}>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Remove
              </Button>
            )}
          </div>
          {busy && <div className="text-xs text-[var(--vivo-muted)]" role="status">Saving image…</div>}
        </div>
      </div>
    </Card>
  );
}

export default function ShopCards() {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get("/crm/community-shop-cards");
      setCards(Array.isArray(data?.cards) ? data.cards : []);
    } catch (requestError) {
      setError(imageError(requestError, "Couldn't load Shop card images"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  return (
    <div className="p-6 md:p-10 max-w-[1100px] mx-auto space-y-5" data-testid="shop-cards-page">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow">Community · Shop content</div>
          <h1 className="font-display text-4xl md:text-5xl tracking-tight mt-2">Shop image cards</h1>
          <div className="gold-rule mt-4" />
          <p className="text-sm text-[var(--vivo-muted)] mt-3 max-w-2xl">
            Replace the four editorial images behind Community Shop shortcuts. Changes are shown to shoppers after their next refresh.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={loading} data-testid="shop-cards-refresh">
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      <Card className="p-4 border-amber-200 bg-amber-50/55 text-sm text-amber-950">
        Use JPEG, PNG, GIF or WebP images up to 5 MB. The card crop is responsive; leave space around faces where possible.
      </Card>
      {error ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-red-600">{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button>
        </Card>
      ) : loading ? (
        <Card className="p-10 text-center text-sm text-[var(--vivo-muted)]">Loading Shop cards…</Card>
      ) : (
        <div className="grid gap-4">{cards.map((card) => <ShopCardEditor key={card.id} card={card} onChanged={load} />)}</div>
      )}
    </div>
  );
}