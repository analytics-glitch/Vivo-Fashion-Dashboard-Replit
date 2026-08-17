import React, { useEffect } from "react";

/**
 * /community-app — formerly a frozen design mockup of the member community
 * app (hardcoded tabs + mockData). That prototype caused real confusion:
 * staff clicked it expecting the live app and saw stale fake data.
 *
 * It now redirects straight to the real production community app at /app/,
 * preserving ?tab= (the tab ids home/community/shop/rewards/profile match
 * the live app's tab ids).
 */
export default function CommunityApp() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    const dest = tab ? `/app/?tab=${encodeURIComponent(tab)}` : "/app/";
    window.location.replace(dest);
  }, []);

  return (
    <div className="flex min-h-[60vh] items-center justify-center text-sm text-gray-500" data-testid="community-app-redirect">
      Taking you to the live Vivo Community app…&nbsp;
      <a href="/app/" className="underline">Open /app/</a>
    </div>
  );
}
