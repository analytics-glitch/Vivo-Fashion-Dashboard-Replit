import React from "react";
import { SectionHeader } from "./ui";

/* Weekly Vivo Spotify playlist — v1 is the standard Spotify embed (no auth,
   no backend). Whoever manages the playlist swaps the ID below (or sets
   VITE_SPOTIFY_PLAYLIST_ID) each week — no other code changes needed.
   To get the ID: Spotify → playlist → Share → Copy link →
   the part after /playlist/ and before the "?" is the ID. */
const DEFAULT_PLAYLIST_ID = "37i9dQZF1DXcBWIGoYBM5M"; // placeholder until Vivo's own playlist is set
export const SPOTIFY_PLAYLIST_ID =
  import.meta.env.VITE_SPOTIFY_PLAYLIST_ID || DEFAULT_PLAYLIST_ID;

export default function WeeklyPlaylist() {
  if (!SPOTIFY_PLAYLIST_ID) return null;
  return (
    <section data-testid="home-weekly-playlist">
      <SectionHeader
        kicker="This week's sound"
         title="This Week's Vivo Playlist by DJ Shaky"
        sub="Our weekly mix — the songs on rotation in-store and behind the scenes."
      />
      <div className="rounded overflow-hidden">
        <iframe
          title="Vivo weekly Spotify playlist"
          data-testid="weekly-playlist-embed"
          src={`https://open.spotify.com/embed/playlist/${SPOTIFY_PLAYLIST_ID}?utm_source=generator`}
          width="100%"
          className="block w-full h-[280px] sm:h-[352px] border-0"
          allowFullScreen
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
        />
      </div>
    </section>
  );
}
