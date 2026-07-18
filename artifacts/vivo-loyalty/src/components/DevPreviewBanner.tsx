import React, { useEffect, useState } from "react";

// High-visibility development-preview indicator. Renders ONLY when the backend
// says this server is running in development (never on the published site).
// Collapsible per session (sessionStorage) — never permanently dismissible.
const LIVE_URL = "https://vivofashionbrands.com";
const COLLAPSE_KEY = "vivo_dev_banner_collapsed";

function isDevHostname() {
  // Fallback only (API unreachable): known dev-preview hostnames.
  const h = window.location.hostname;
  return (
    h === "localhost" || h === "127.0.0.1" ||
    /\.replit\.dev$/.test(h) || /\.repl\.co$/.test(h) || /\.repl\.dev$/.test(h)
  );
}

export default function DevPreviewBanner() {
  const [isDev, setIsDev] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return sessionStorage.getItem(COLLAPSE_KEY) === "1"; } catch (e) { return false; }
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/environment", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
      .then((d) => { if (!cancelled) setIsDev(Boolean(d) && d.environment === "development"); })
      .catch(() => { if (!cancelled) setIsDev(isDevHostname()); });
    return () => { cancelled = true; };
  }, []);

  if (!isDev) return null;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { sessionStorage.setItem(COLLAPSE_KEY, next ? "1" : "0"); } catch (e) { /* ignore */ }
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        title="Development preview — click to expand"
        aria-label="Development preview — click to expand"
        data-testid="dev-preview-strip"
        style={{
          display: "block", width: "100%", height: 10, background: "#d97706",
          border: "none", cursor: "pointer", padding: 0,
        }}
      />
    );
  }

  return (
    <div
      role="status"
      data-testid="dev-preview-banner"
      style={{
        background: "#d97706", color: "#fff", padding: "8px 16px",
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 12, flexWrap: "wrap", textAlign: "center",
        fontSize: 13, fontWeight: 700, letterSpacing: "0.02em", lineHeight: 1.35,
      }}
    >
      <span>DEVELOPMENT PREVIEW — data entered here will NOT appear on the live site.</span>
      <a
        href={LIVE_URL}
        style={{ color: "#fff", textDecoration: "underline", fontWeight: 700 }}
      >
        Go to the live site
      </a>
      <button
        type="button"
        onClick={toggle}
        style={{
          background: "rgba(255,255,255,.18)", border: "1px solid rgba(255,255,255,.55)",
          color: "#fff", borderRadius: 6, fontSize: 11, fontWeight: 700,
          padding: "2px 9px", cursor: "pointer",
        }}
      >
        Hide
      </button>
    </div>
  );
}
