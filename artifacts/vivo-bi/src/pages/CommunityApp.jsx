import React, { useState, useEffect } from "react";
import "@fontsource-variable/fraunces";
import "@fontsource/poppins/400.css"; // Century Gothic stand-in for the Vivo wordmark
import TabHome from "@/components/community/TabHome";
import TabCommunity from "@/components/community/TabCommunity";
import TabShop from "@/components/community/TabShop";
import TabRewards from "@/components/community/TabRewards";
import TabProfile from "@/components/community/TabProfile";
import { SlotImagesProvider } from "@/components/community/ui";

const TABS = [
  { id: "home", label: "Home" },
  { id: "community", label: "Community" },
  { id: "shop", label: "Shop" },
  { id: "rewards", label: "Johari" },
  { id: "profile", label: "Profile" },
];

export default function CommunityApp() {
  const initialTab = new URLSearchParams(window.location.search).get("tab") || "home";
  const [tab, setTab] = useState(TABS.some(t => t.id === initialTab) ? initialTab : "home");

  // Sync tab state to URL
  useEffect(() => {
    const url = new URL(window.location);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url);
  }, [tab]);

  return (
    // One manifest fetch per page visit — every 📸 slot below reads from
    // this provider instead of firing its own request.
    <SlotImagesProvider>
      <style>{`
        @keyframes floatUp {
          0% { opacity: 1; transform: translate(-50%, 0) scale(1); }
          100% { opacity: 0; transform: translate(-50%, -40px) scale(1.2); }
        }
        .animate-float-up {
          animation: floatUp 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
        }
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
        .hide-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
        .community-scope h1, .community-scope h2, .community-scope h3 {
          font-family: 'Fraunces Variable', Georgia, serif;
          font-weight: 500;
          letter-spacing: -0.01em;
        }
      `}</style>
      <div className="community-scope min-h-[100dvh] bg-[#fbf9f6] text-[#2c2a29] font-sans selection:bg-[#FE5000] selection:text-white" style={{ '--community-accent': '#FE5000' }}>
        {/* Brand mark — official treatment: white Century Gothic (regular)
            wordmark on Pantone 021C (#FE5000), no ® (dropped). */}
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-8 pt-5 pb-2 flex items-center gap-3">
          <span role="img" aria-label="Vivo" className="inline-flex items-center justify-center rounded-lg bg-[#FE5000] h-9 px-3 select-none">
            <span aria-hidden="true" className="text-white text-[19px] font-normal leading-none tracking-[0.02em]" style={{ fontFamily: "'Century Gothic','CenturyGothic','Poppins',sans-serif" }}>Vivo</span>
          </span>
          <span className="text-[13px] font-normal uppercase tracking-[0.3em] text-[#2c2a29]" style={{ fontFamily: "'Century Gothic','CenturyGothic','Poppins',sans-serif" }}>Johari</span>
        </div>

        {/* Sticky Tab Bar */}
        <div 
          className="sticky border-b border-[#e8dfd5] bg-[#fbf9f6]/95 backdrop-blur-md z-30 flex items-center justify-center px-4 overflow-x-auto hide-scrollbar"
          style={{ top: "var(--app-navbar-h)" }}
        >
          <div className="flex w-full max-w-[1200px] gap-6 sm:gap-8">
            {TABS.map((t) => (
              <button
                key={t.id}
                data-testid={`tab-${t.id}`}
                onClick={() => setTab(t.id)}
                className={`py-4 text-sm sm:text-base font-semibold whitespace-nowrap transition-colors relative ${
                  tab === t.id ? "text-[#C43E00]" : "text-[#7a746e] hover:text-[#2c2a29]"
                }`}
              >
                {t.label}
                {tab === t.id && (
                  <span className="absolute bottom-0 left-0 w-full h-[3px] bg-[#FE5000] rounded-t-full" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Main Content Area */}
        <main className="mx-auto max-w-[1200px] p-4 sm:p-6 lg:p-8 animate-in fade-in duration-500 pb-24">
          {tab === "home" && <TabHome onNavigate={setTab} />}
          {tab === "community" && <TabCommunity />}
          {tab === "shop" && <TabShop />}
          {tab === "rewards" && <TabRewards />}
          {tab === "profile" && <TabProfile />}
        </main>
      </div>
    </SlotImagesProvider>
  );
}
