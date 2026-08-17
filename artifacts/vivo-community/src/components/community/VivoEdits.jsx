import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronRight, Heart, MessageCircle, Share, ShoppingBag, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useCart } from "@/context/CartContext";
import { useWishlist } from "@/context/WishlistContext";
import { cardCls, kes, SectionHeader, btnPrimary, MAX_PER_ORDER } from "./ui";
import PostDetailModal from "./PostDetailModal";

/* =============================================================================
   VIVO EDITS — editorial, creator-curated shoppable looks.

   Three surfaces share this file:
   - VivoEditsHome    → the home-page section (max 3 large editorial cards)
   - VivoEditsAllView → the "View All Edits" grid page (?page=edits)
   - VivoEditDetail   → the full editorial view for one edit (?edit=<id>)

   Reads are open to guests (image URLs are public). Every member-write action
   — Add to Bag, Shop the Look, Save, like, comment, share — is guest-fenced
   via onGuest(), matching the rest of CommunityShell.
   ========================================================================== */

/* ---------------- Shared editorial card ---------------- */

/* Large image-led card. 4:5 portrait cover, top-anchored so faces stay in
   frame; a soft gradient sits ONLY behind the small label + copy strip at
   the bottom so nothing washes over the photograph itself. */
function EditCard({ edit, onOpen, testId }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => onOpen(edit.id)}
      className="group text-left w-full rounded overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
    >
      <div className={`${cardCls} overflow-hidden flex flex-col h-full`}>
        <div className="relative aspect-[4/5] bg-secondary overflow-hidden">
          {!failed && edit.cover_image && (
            <img
              src={edit.cover_image}
              alt={edit.cover_alt || `${edit.title} — curated by ${edit.creator_name}`}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              loading="lazy"
              draggable={false}
              className="absolute inset-0 w-full h-full object-cover object-[center_top] transition-transform duration-700 group-hover:scale-[1.03]"
            />
          )}
          {(!loaded || failed) && <div className="absolute inset-0 bg-secondary animate-pulse" aria-hidden="true" />}
          {/* Gradient only where the label sits — keeps copy off faces. */}
          <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/45 to-transparent pointer-events-none" />
          <div className="absolute top-3 left-3">
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-white/95">
              <Sparkles size={11} /> Vivo Edit
            </span>
          </div>
        </div>
        <div className="p-5 flex flex-col flex-grow">
          <h3 className="font-serif text-xl text-foreground leading-snug mb-1">&ldquo;{edit.title}&rdquo;</h3>
          <div className="text-[12px] font-medium text-primary-ink mb-2">Curated by {edit.creator_name}</div>
          {edit.description && (
            <p className="text-[13px] text-muted-foreground leading-relaxed line-clamp-1 mb-4">{edit.description}</p>
          )}
          <div className="mt-auto">
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground group-hover:gap-2.5 transition-all">
              Explore Her Style <ArrowRight size={14} />
            </span>
            {edit.disclosure && (
              <p className="text-[11px] text-muted-foreground/70 mt-3 leading-relaxed">{edit.disclosure}</p>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

/* ---------------- Home section ---------------- */

export function VivoEditsHome({ onOpenEdit, onViewAll, feed, onOpenProduct, onNavigate }) {
  const [state, setState] = useState(null); // null = loading | { items, total }

  useEffect(() => {
    let alive = true;
    api.edits(3)
      .then((d) => { if (alive) setState({ items: d.items || [], total: d.total ?? (d.items || []).length }); })
      .catch(() => { if (alive) setState({ items: [], total: 0 }); });
    return () => { alive = false; };
  }, []);

  // Worn by the Community integration (Point 4)
  const looks = (feed || []).filter((p) => p?.tagged?.length && p.post_type !== "question").slice(0, 3);

  // Render the section if we have EITHER items or community looks (to show the related community looks)
  if ((!state || !state.items.length) && (!looks || !looks.length)) return null;

  const items = state ? state.items.slice(0, 3) : [];
  
  // Create an array with length of max(items.length, looks.length) up to 3
  const length = Math.max(items.length, looks.length);
  const combined = Array.from({ length }).map((_, i) => ({
    edit: items[i] || null,
    look: looks[i] || null
  }));

  return (
    <section data-testid="home-vivo-edits">
      <div className="flex items-end justify-between gap-4 mb-4">
        <SectionHeader kicker="Vivo Edits" title="Curated by Creators We Love" sub="Editorial looks, shoppable to the last piece." />
        {state && state.total > 3 && (
          <button
            data-testid="home-vivo-edits-viewall"
            onClick={onViewAll}
            className="shrink-0 mb-4 text-[13px] font-medium text-primary-ink hover:underline inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
          >
            View All Edits <ChevronRight size={14} />
          </button>
        )}
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {combined.map((c, index) => (
          <div key={`edit-col-${index}`} className="flex flex-col gap-4">
            {/* The creator edit */}
            {c.edit && (
              <EditCard edit={c.edit} onOpen={onOpenEdit} testId={`home-vivo-edit-${c.edit.id}`} />
            )}
            
            {/* The related community look (if available) */}
            {c.look && (
              <div className={`${cardCls} p-4 flex flex-col mt-auto bg-secondary/30 min-h-[140px]`} data-testid={`shop-look-${c.look.id}`}>
                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">Worn by the community</div>
                <div className="flex items-center gap-2.5 mb-3">
                  <span className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-[10px] font-bold text-foreground">
                    {c.look.author.initials}
                  </span>
                  <span className="text-[13px] font-semibold text-foreground truncate">@{c.look.author.username}</span>
                </div>
                <p className="text-[13px] text-muted-foreground leading-relaxed line-clamp-2 mb-4 flex-grow">{c.look.caption}</p>
                <button
                  data-testid={`shop-look-cta-${c.look.id}`}
                  onClick={() => (c.look.tagged?.[0]?.sku ? onOpenProduct?.(c.look.tagged[0].sku) : onNavigate("shop"))}
                  className="h-10 rounded border border-border text-foreground text-[13px] font-medium hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary mt-auto"
                >
                  Shop the Look
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------- All edits grid page ---------------- */

export function VivoEditsAllView({ onBack, onOpenEdit }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    window.scrollTo({ top: 0 });
    api.edits(60)
      .then((d) => { if (alive) setState({ items: d.items || [], total: d.total ?? 0 }); })
      .catch((e) => { if (alive) setError(e.message || "Couldn't load the edits right now"); });
    return () => { alive = false; };
  }, []);

  return (
    <div data-testid="vivo-edits-all" className="max-w-4xl mx-auto animate-in fade-in duration-300">
      <button
        data-testid="vivo-edits-all-back"
        onClick={onBack}
        className="inline-flex items-center gap-2 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors mb-6 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft size={16} strokeWidth={1.5} /> Back
      </button>
      <SectionHeader kicker="Vivo Edits" title="Curated by Creators We Love" sub="Editorial looks, shoppable to the last piece." />
      {error ? (
        <div className="py-16 text-center text-muted-foreground text-sm">{error}</div>
      ) : !state ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded bg-secondary animate-pulse aspect-[3/4]" />
          ))}
        </div>
      ) : state.items.length === 0 ? (
        <div className="py-16 text-center text-muted-foreground text-sm">No edits are live right now — check back soon.</div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          {state.items.map((e) => (
            <EditCard key={e.id} edit={e} onOpen={onOpenEdit} testId={`vivo-edit-${e.id}`} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Shop-the-edit product row ---------------- */

function ShopProduct({ t, onAdd, onSave, saved, busy }) {
  const [failed, setFailed] = useState(false);
  return (
    <div data-testid={`edit-product-${t.sku}`} className={`${cardCls} p-4 flex gap-4 items-center`}>
      <div className="w-20 h-24 shrink-0 rounded-sm bg-secondary overflow-hidden">
        {t.img && !failed ? (
          <img src={t.img} alt={t.name} loading="lazy" onError={() => setFailed(true)} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-secondary" />
        )}
      </div>
      <div className="flex-grow min-w-0">
        <div className="font-serif text-[15px] text-foreground leading-snug line-clamp-2">{t.name}</div>
        <div className="text-[13px] text-foreground/80 mt-1">{kes(t.price)}</div>
        <div className="flex items-center gap-3 mt-3">
          <button
            type="button"
            data-testid={`edit-product-add-${t.sku}`}
            onClick={() => onAdd(t)}
            disabled={busy}
            className="h-9 px-4 rounded bg-foreground text-background text-[13px] font-medium inline-flex items-center gap-1.5 hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            <ShoppingBag size={14} /> Add to Bag
          </button>
          <button
            type="button"
            data-testid={`edit-product-save-${t.sku}`}
            aria-label={saved ? "Remove from wishlist" : "Save to wishlist"}
            aria-pressed={saved}
            onClick={() => onSave(t)}
            className="w-9 h-9 shrink-0 rounded-full border border-border flex items-center justify-center text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Heart size={16} strokeWidth={1.5} className={saved ? "fill-primary text-primary-ink" : ""} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Edit detail view ---------------- */

export function VivoEditDetail({ editId, onBack, onOpenProduct, member, onGuest }) {
  const { add } = useCart();
  const { has, toggle } = useWishlist();
  const [detail, setDetail] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Reused feed machinery for like/comment/share, driven by feed_post_id.
  const [feedPost, setFeedPost] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const restoreY = useRef(0);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError("");
    setFeedPost(null);
    setModalOpen(false);
    window.scrollTo({ top: 0 });
    api.editDetail(editId)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setError(e.status === 404 ? "This edit is no longer available." : (e.message || "Couldn't load this edit right now.")); });
    return () => { alive = false; };
  }, [editId]);

  // Pull the linked feed post for like/comment counts + state. Only signed-in
  // members carry my_liked; guests still see the counts.
  useEffect(() => {
    if (!detail?.feed_post_id) return;
    let alive = true;
    api.post(detail.feed_post_id)
      .then((p) => { if (alive) setFeedPost(p?.post || p); })
      .catch(() => {});
    return () => { alive = false; };
  }, [detail?.feed_post_id]);

  const gallery = useMemo(() => {
    if (!detail) return [];
    const imgs = (detail.images || []).map((im) => ({ src: im.path, alt: im.alt || detail.cover_alt || detail.title }));
    // Cover first, then the remaining images.
    if (detail.cover_image && !imgs.some((i) => i.src === detail.cover_image)) {
      imgs.unshift({ src: detail.cover_image, alt: detail.cover_alt || detail.title });
    }
    return imgs;
  }, [detail]);

  const guard = (fn) => (...args) => {
    if (!member) { onGuest?.(); return; }
    return fn(...args);
  };

  // Add one tagged product — fetch its live sizes and add the first in-stock
  // one, matching ProductDetail's add-to-bag call signature exactly.
  const addProduct = async (t) => {
    setBusy(true);
    try {
      const p = await api.product(t.sku);
      const size = (p.sizes || []).find((s) => s.in_stock) || (p.sizes || [])[0];
      if (!size) return;
      add({
        key: size.sku,
        sku: p.sku,
        name: p.name,
        color: p.color,
        style_number: p.style_number || "",
        size: size.size === "F" ? "One Size" : size.size,
        qty: 1,
        price: p.price,
        image: p.images?.[0] || t.img || "",
        maxStock: MAX_PER_ORDER,
      });
    } catch { /* quiet — the toast simply won't fire */ }
    finally { setBusy(false); }
  };

  const addAll = async () => {
    const tagged = detail?.tagged || [];
    setBusy(true);
    try {
      for (const t of tagged) {
        // Sequential so each add's toast/merge stays consistent.
        // eslint-disable-next-line no-await-in-loop
        const p = await api.product(t.sku).catch(() => null);
        if (!p) continue;
        const size = (p.sizes || []).find((s) => s.in_stock) || (p.sizes || [])[0];
        if (!size) continue;
        add({
          key: size.sku,
          sku: p.sku,
          name: p.name,
          color: p.color,
          style_number: p.style_number || "",
          size: size.size === "F" ? "One Size" : size.size,
          qty: 1,
          price: p.price,
          image: p.images?.[0] || t.img || "",
          maxStock: MAX_PER_ORDER,
        });
      }
    } finally { setBusy(false); }
  };

  const saveProduct = (t) => {
    toggle({ sku: t.sku, name: t.name, price: t.price, image: t.img || "", color: "", category: "" });
  };

  const patchFeedPost = (id, patch) => setFeedPost((p) => (p && p.id === id ? { ...p, ...patch } : p));

  const openComments = guard(() => {
    if (!feedPost) return;
    restoreY.current = window.scrollY;
    setModalOpen(true);
  });

  const toggleLike = guard(() => {
    if (!feedPost) return;
    const wasLiked = feedPost.my_liked;
    const wasCount = feedPost.like_count || 0;
    patchFeedPost(feedPost.id, { my_liked: !wasLiked, like_count: wasCount + (wasLiked ? -1 : 1) });
    api.likePost(feedPost.id)
      .then((r) => patchFeedPost(feedPost.id, { my_liked: r.liked, like_count: r.like_count }))
      .catch(() => patchFeedPost(feedPost.id, { my_liked: wasLiked, like_count: wasCount }));
  });

  const share = async () => {
    const url = window.location.href;
    const shareData = { title: detail?.title ? `Vivo Edit — ${detail.title}` : "Vivo Edit", url };
    try {
      if (navigator.share) { await navigator.share(shareData); return; }
    } catch { /* cancelled / unsupported — fall through to clipboard */ }
    try { await navigator.clipboard?.writeText(url); } catch { /* ignore */ }
  };

  if (error) {
    return (
      <div data-testid="vivo-edit-detail" className="max-w-2xl mx-auto text-center py-20">
        <p className="text-muted-foreground mb-6">{error}</p>
        <button onClick={onBack} className="h-11 px-6 rounded border border-border text-foreground font-medium text-[14px] hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          Back to Edits
        </button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div data-testid="vivo-edit-detail-loading" className="max-w-3xl mx-auto animate-in fade-in duration-300">
        <div className="h-6 w-24 bg-secondary rounded animate-pulse mb-6" />
        <div className="aspect-[4/5] bg-secondary rounded animate-pulse mb-6 max-w-md" />
        <div className="h-8 w-2/3 bg-secondary rounded animate-pulse mb-3" />
        <div className="h-4 w-1/3 bg-secondary rounded animate-pulse" />
      </div>
    );
  }

  const cover = gallery[0];
  const rest = gallery.slice(1);

  return (
    <div data-testid="vivo-edit-detail" className="max-w-3xl mx-auto animate-in fade-in duration-500 pb-8">
      <button
        data-testid="vivo-edit-back"
        onClick={onBack}
        className="inline-flex items-center gap-2 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors mb-6 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft size={16} strokeWidth={1.5} /> Back to Edits
      </button>

      <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-3 inline-flex items-center gap-1.5">
        <Sparkles size={12} /> Vivo Edit
      </div>

      {cover && (
        <div className="relative rounded overflow-hidden bg-secondary mb-6 max-w-md">
          <img
            src={cover.src}
            alt={cover.alt}
            className="w-full h-auto object-cover"
            draggable={false}
          />
        </div>
      )}

      <h1 data-testid="vivo-edit-title" className="font-serif text-3xl sm:text-4xl text-foreground leading-tight mb-2">
        &ldquo;{detail.title}&rdquo;
      </h1>
      <div className="text-[14px] text-foreground mb-1">
        Curated by <span className="font-medium">{detail.creator_name}</span>
        {detail.creator_username && <span className="text-muted-foreground"> · @{detail.creator_username}</span>}
      </div>

      {/* Like / comment / share — reuses the feed post via feed_post_id. */}
      {detail.feed_post_id && (
        <div className="flex items-center gap-5 mt-4 mb-6 pb-6 border-b border-border">
          <button
            type="button"
            data-testid="vivo-edit-like"
            onClick={toggleLike}
            aria-label={feedPost?.my_liked ? "Unlike this edit" : "Like this edit"}
            aria-pressed={!!feedPost?.my_liked}
            className={`flex items-center gap-1.5 min-h-[44px] font-medium transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${feedPost?.my_liked ? "text-primary-ink" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Heart size={20} strokeWidth={1.5} className={feedPost?.my_liked ? "fill-primary text-primary-ink" : ""} />
            <span className="text-sm" data-testid="vivo-edit-like-count">{feedPost?.like_count ?? 0}</span>
          </button>
          <button
            type="button"
            data-testid="vivo-edit-comment"
            onClick={openComments}
            aria-label="View comments"
            className="flex items-center gap-1.5 min-h-[44px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <MessageCircle size={20} strokeWidth={1.5} />
            <span className="text-sm">{feedPost?.comment_count ?? 0}</span>
          </button>
          <button
            type="button"
            data-testid="vivo-edit-share"
            onClick={share}
            aria-label="Share this edit"
            className="flex items-center gap-1.5 min-h-[44px] font-medium text-muted-foreground hover:text-foreground transition-colors ml-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Share size={20} strokeWidth={1.5} />
          </button>
        </div>
      )}

      {detail.intro && (
        <p className="text-[15px] text-foreground/90 leading-relaxed mb-6 max-w-2xl">{detail.intro}</p>
      )}

      {detail.disclosure && (
        <p className="text-[12px] text-muted-foreground/80 leading-relaxed mb-8 max-w-2xl">{detail.disclosure}</p>
      )}

      {/* Remaining images — responsive, quality-preserving, no distortion. */}
      {rest.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-12">
          {rest.map((im, i) => (
            <div key={im.src || i} className="rounded overflow-hidden bg-secondary">
              <img src={im.src} alt={im.alt} loading="lazy" className="w-full h-auto object-cover" draggable={false} />
            </div>
          ))}
        </div>
      )}

      {/* Shop the Edit */}
      {detail.tagged?.length > 0 && (
        <section data-testid="vivo-edit-shop">
          <div className="flex items-end justify-between gap-4 mb-4">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1.5">Shop the Edit</div>
              <h2 className="font-serif text-2xl text-foreground leading-tight">Every piece in the look</h2>
            </div>
          </div>
          <button
            type="button"
            data-testid="vivo-edit-shop-look"
            onClick={guard(addAll)}
            disabled={busy}
            className={`${btnPrimary} mb-6`}
          >
            <ShoppingBag size={16} /> Shop the Look — add all {detail.tagged.length} pieces
          </button>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {detail.tagged.map((t) => (
              <ShopProduct
                key={t.sku}
                t={t}
                busy={busy}
                saved={has(t.sku)}
                onAdd={guard(addProduct)}
                onSave={guard(saveProduct)}
              />
            ))}
          </div>
        </section>
      )}

      {modalOpen && feedPost && (
        <PostDetailModal
          restoreY={restoreY.current}
          posts={[feedPost]}
          index={0}
          onIndex={() => {}}
          onClose={() => setModalOpen(false)}
          onOpenProduct={(sku) => { setModalOpen(false); onOpenProduct?.(sku); }}
          onCounts={patchFeedPost}
        />
      )}
    </div>
  );
}
