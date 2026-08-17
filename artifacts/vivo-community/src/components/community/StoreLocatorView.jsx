import React, { useMemo, useState } from "react";
import { MapPin, Phone, Navigation, LocateFixed, Search, Map as MapIcon, List, Clock, Loader2 } from "lucide-react";
import { cardCls } from "./ui";
import {
  STORE_DIRECTORY, STORE_COUNTRIES, directionsLink, mapEmbedSrc, distanceKm,
} from "@/lib/storeDirectory";

/* Find a Store — a quiet, secondary service page (Account → Help & Support).
   Geolocation is requested ONLY when she taps "Use My Location"; search and
   the country filter work fully without it. */

export default function StoreLocatorView({ onBack }) {
  const [q, setQ] = useState("");
  const [country, setCountry] = useState("All");
  const [pos, setPos] = useState(null);          // {lat,lng} after permission
  const [locState, setLocState] = useState("");  // "" | "asking" | "denied" | "on"
  const [view, setView] = useState("list");      // "list" | "map"
  const [mapStore, setMapStore] = useState(null);

  const askLocation = () => {
    if (!navigator.geolocation) { setLocState("denied"); return; }
    setLocState("asking");
    navigator.geolocation.getCurrentPosition(
      (p) => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude }); setLocState("on"); },
      () => setLocState("denied"),
      { timeout: 10000, maximumAge: 300000 },
    );
  };

  const stores = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = STORE_DIRECTORY.filter((s) => {
      if (country !== "All" && s.country !== country) return false;
      if (!needle) return true;
      return [s.name, s.mall, s.address, s.city, s.country]
        .some((f) => f.toLowerCase().includes(needle));
    });
    if (pos) {
      list = list
        .map((s) => ({ ...s, km: distanceKm(pos.lat, pos.lng, s.lat, s.lng) }))
        .sort((a, b) => a.km - b.km);
    }
    return list;
  }, [q, country, pos]);

  const focus = mapStore && stores.some((s) => s.name === mapStore.name) ? mapStore : stores[0];

  return (
    <div className="max-w-2xl mx-auto animate-in fade-in duration-300 pb-24">
      <button onClick={onBack} className="text-[13px] text-muted-foreground hover:text-foreground mb-5 inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        ← Back
      </button>
      <h1 className="font-serif text-3xl text-foreground mb-2">Find a Store</h1>
      <p className="text-[13px] text-muted-foreground leading-relaxed mb-6 max-w-lg">
        Prefer to shop in person? Here's every Vivo store across Kenya, Uganda
        and Rwanda.
      </p>

      {/* Search + Use My Location */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-grow">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            data-testid="store-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by area, city or mall"
            className="w-full h-11 pl-10 pr-4 rounded border border-border bg-background text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <button
          data-testid="store-use-location"
          onClick={askLocation}
          disabled={locState === "asking" || locState === "on"}
          className="h-11 px-4 rounded border border-border bg-background text-[13px] font-medium text-foreground inline-flex items-center justify-center gap-2 hover:bg-secondary transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {locState === "asking" ? <Loader2 size={14} className="animate-spin" /> : <LocateFixed size={14} />}
          {locState === "on" ? "Location on" : "Use My Location"}
        </button>
      </div>
      {locState === "denied" && (
        <p data-testid="store-loc-denied" className="text-[12px] text-muted-foreground mb-4">
          No problem — you can still search for a store by area, city or mall above.
        </p>
      )}

      {/* Country filter + view toggle */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex gap-2 overflow-x-auto hide-scrollbar">
          {["All", ...STORE_COUNTRIES].map((c) => (
            <button
              key={c}
              data-testid={`store-country-${c}`}
              onClick={() => setCountry(c)}
              className={`px-4 h-9 rounded-sm text-[11px] font-bold uppercase tracking-wider whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                country === c
                  ? "bg-foreground text-background shadow-sm"
                  : "bg-background text-muted-foreground hover:bg-secondary border border-border"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <button
          data-testid="store-view-toggle"
          onClick={() => setView((v) => (v === "list" ? "map" : "list"))}
          className="h-9 px-3 rounded border border-border bg-background text-[12px] font-medium text-foreground inline-flex items-center gap-1.5 hover:bg-secondary transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {view === "list" ? <><MapIcon size={13} /> Map</> : <><List size={13} /> List</>}
        </button>
      </div>

      {/* Map view — one store focused at a time, tap a name to move the pin */}
      {view === "map" && focus && (
        <div className={`${cardCls} overflow-hidden mb-6`} data-testid="store-map">
          <iframe
            title={`Map — ${focus.name}`}
            src={mapEmbedSrc(focus)}
            className="w-full h-64 sm:h-80 border-0"
            loading="lazy"
          />
          <div className="px-4 py-3 flex items-center justify-between gap-3 border-t border-border">
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-foreground truncate">{focus.name}</div>
              <div className="text-[12px] text-muted-foreground truncate">{focus.mall} · {focus.city}</div>
            </div>
            <a href={directionsLink(focus)} target="_blank" rel="noreferrer"
              className="text-[12px] font-medium text-primary-ink hover:underline underline-offset-2 inline-flex items-center gap-1 shrink-0">
              <Navigation size={12} /> Directions
            </a>
          </div>
        </div>
      )}

      {/* Store list */}
      {stores.length === 0 ? (
        <div className="py-14 text-center text-muted-foreground text-sm">
          No stores match "{q}" — try a different area, city or mall.
        </div>
      ) : (
        <div className="space-y-3">
          {stores.map((s) => (
            <div key={s.name} data-testid={`store-card-${s.name.replace(/\s+/g, "-")}`} className={`${cardCls} p-5`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <button
                    onClick={() => { setMapStore(s); setView("map"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                    className="text-left font-medium text-[15px] text-foreground hover:underline underline-offset-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {s.name}
                  </button>
                  <div className="text-[13px] text-muted-foreground mt-0.5">{s.mall}</div>
                  <div className="text-[12px] text-muted-foreground mt-1 flex items-center gap-1">
                    <MapPin size={11} className="shrink-0" /> {s.address}, {s.city}, {s.country}
                  </div>
                  <div className="text-[12px] text-muted-foreground mt-1 flex items-center gap-1">
                    <Clock size={11} className="shrink-0" /> {s.hours}
                  </div>
                  <div className="text-[12px] text-muted-foreground mt-1 flex items-center gap-1">
                    <Phone size={11} className="shrink-0" /> {s.phone}
                  </div>
                </div>
                {typeof s.km === "number" && (
                  <span data-testid="store-distance" className="text-[11px] font-bold uppercase tracking-wider text-primary-ink bg-primary/5 border border-primary/20 rounded-sm px-2 py-1 shrink-0">
                    {s.km < 10 ? s.km.toFixed(1) : Math.round(s.km)} km
                  </span>
                )}
              </div>
              <div className="flex gap-2 mt-4">
                <a
                  data-testid={`store-directions-${s.name.replace(/\s+/g, "-")}`}
                  href={directionsLink(s)} target="_blank" rel="noreferrer"
                  className="flex-1 h-10 rounded border border-border bg-background text-[13px] font-medium text-foreground inline-flex items-center justify-center gap-1.5 hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Navigation size={13} /> Get Directions
                </a>
                <a
                  data-testid={`store-call-${s.name.replace(/\s+/g, "-")}`}
                  href={s.phoneHref}
                  className="flex-1 h-10 rounded border border-border bg-background text-[13px] font-medium text-foreground inline-flex items-center justify-center gap-1.5 hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Phone size={13} /> Call Store
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground mt-8 text-center">
        Can't make it to a store? Everything is available to shop right here in the app.
      </p>
    </div>
  );
}
