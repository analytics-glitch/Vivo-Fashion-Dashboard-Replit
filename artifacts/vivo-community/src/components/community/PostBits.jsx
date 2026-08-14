import React from "react";
import { ImagePlaceholder } from "./ui";

/* Shared post pieces — used by the Home feed cards, the Community grid and
   the post detail modal (lives here so TabHome and PostDetailModal don't
   import each other). */

/* Deliberately varied placeholder treatment so the feed has rhythm.
   Aspect ratio comes from the post's layout variant. */
export function PostVisual({ post, className = "mb-4" }) {
  const ar =
    post.variant === "square" ? "aspect-square" :
    post.variant === "landscape" ? "aspect-[4/3]" :
    "aspect-[4/5]";
  // Real media first: member uploads ride /entry-photo/{id} (photo or video),
  // seeded posts carry catalogue imagery in image_url. Placeholders only when
  // a post genuinely has no visual (e.g. questions).
  const memberSrc = post.photo_path ? "/api/community" + post.photo_path : null;
  const imgSrc = memberSrc && post.media_kind !== "video" ? memberSrc : (post.image_url || null);
  if (memberSrc && post.media_kind === "video") {
    return (
      <div className={`w-full ${ar} rounded bg-foreground/95 relative overflow-hidden ${className}`}>
        <video
          src={memberSrc}
          controls
          playsInline
          preload="metadata"
          className="absolute inset-0 w-full h-full object-contain"
          data-testid={`post-video-${post.id}`}
        />
      </div>
    );
  }
  if (imgSrc) {
    return (
      <div className={`w-full ${ar} rounded bg-secondary/60 relative overflow-hidden ${className}`}>
        <img
          src={imgSrc}
          alt={post.caption ? `Look by @${post.author?.username || "member"} — ${post.caption.slice(0, 60)}` : `Look by @${post.author?.username || "member"}`}
          loading="lazy"
          className="absolute inset-0 w-full h-full object-cover"
        />
      </div>
    );
  }
  if (post.visual === "dark") {
    return (
      <div className={`w-full ${ar} rounded bg-foreground relative overflow-hidden flex items-center justify-center ${className}`}>
        <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/5 rounded-full blur-2xl pointer-events-none" />
        <span className="font-serif italic text-lg text-background/60">Look by @{post.author.username}</span>
      </div>
    );
  }
  return <ImagePlaceholder aspectRatio={ar} text={`Look by @${post.author.username}`} className={className} />;
}

/* Relative time in the app's quiet voice — coarse buckets are enough. */
export function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  if (d < 35) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
