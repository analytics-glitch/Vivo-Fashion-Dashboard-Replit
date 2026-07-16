import { useEffect, useState } from "react";
import { Button } from "./ui";

/**
 * Shows an "Update available" banner (same style as the install prompt) when a
 * newer build has been deployed than the one currently running — so users on an
 * out-of-date install can refresh to the latest without reinstalling.
 *
 * Detection: compare the build's manifest hash in the loaded document against
 * the one in the server's current index.html.
 */
function loadedBuildHash(): string | null {
  const el = document.querySelector('script[src*="/assets/manifest-"]') as HTMLScriptElement | null;
  return el?.src.match(/manifest-([^.]+)\.js/)?.[1] ?? null;
}

export function UpdatePrompt() {
  const [available, setAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    const current = loadedBuildHash();
    if (!current) return;

    let checking = false;
    const check = async () => {
      if (document.visibilityState !== "visible" || checking || available) return;
      checking = true;
      try {
        const html = await (await fetch("/", { cache: "no-store" })).text();
        const latest = html.match(/manifest-([^.]+)\.js/)?.[1] ?? null;
        if (latest && latest !== current) setAvailable(true);
      } catch {
        /* offline / transient — ignore */
      } finally {
        checking = false;
      }
    };

    // Check on load, when the app is resumed, and periodically while open.
    check();
    document.addEventListener("visibilitychange", check);
    const id = window.setInterval(check, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(id);
    };
  }, [available]);

  if (!available) return null;

  return (
    <div className="rise fixed inset-x-3 bottom-24 z-40 mx-auto max-w-md rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-4 shadow-lg">
      <div className="flex items-center gap-3">
        <img
          src="/loyalty-app/icons/vivo-mark.png"
          alt="Vivo Loyalty"
          className="h-11 w-11 shrink-0 rounded-xl object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Update available</p>
          <p className="text-xs text-muted">Update to get the new features.</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="ghost" onClick={() => setAvailable(false)} className="flex-1 py-2">
          Later
        </Button>
        <Button
          loading={updating}
          onClick={() => {
            setUpdating(true);
            window.location.reload();
          }}
          className="flex-1 py-2"
        >
          Update
        </Button>
      </div>
    </div>
  );
}
